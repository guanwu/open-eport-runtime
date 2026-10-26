// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

using System.Diagnostics;

namespace EportRuntime;

public sealed record CommandSpec(
  string File,
  IReadOnlyList<string> Args,
  string Cwd,
  IReadOnlyDictionary<string, string> Env,
  int TimeoutMs);

public sealed record CommandOutcome(int ExitCode, long DurationMs);

// Runs one child with stdin from a file and stdout/stderr to files. Output is
// complete on disk before the caller streams it, so the terminal message and the
// staged output stay consistent.
public sealed class CommandRunner
{
  private const int BufferSize = 64 * 1024;
  private static readonly TimeSpan OutputDrainTimeout = TimeSpan.FromSeconds(2);

  public async Task<CommandOutcome> RunAsync(
    CommandSpec spec,
    string stdinPath,
    string stdoutPath,
    string stderrPath,
    CancellationToken cancellationToken)
  {
    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
    if (spec.TimeoutMs > 0)
    {
      timeout.CancelAfter(spec.TimeoutMs);
    }

    var startInfo = new ProcessStartInfo
    {
      FileName = spec.File,
      WorkingDirectory = spec.Cwd,
      UseShellExecute = false,
      CreateNoWindow = true,
      RedirectStandardInput = true,
      RedirectStandardOutput = true,
      RedirectStandardError = true,
    };

    foreach (var argument in spec.Args)
    {
      startInfo.ArgumentList.Add(argument);
    }

    foreach (var pair in spec.Env)
    {
      startInfo.Environment[pair.Key] = pair.Value;
    }

    using var process = new Process { StartInfo = startInfo };
    var stopwatch = Stopwatch.StartNew();
    Task? pumps = null;

    try
    {
      try
      {
        if (!process.Start())
        {
          throw new EportException($"{spec.File}: could not start");
        }
      }
      catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
      {
        throw new EportException($"{spec.File}: {ex.Message}");
      }

      var output = Task.WhenAll(
        PumpAsync(process.StandardOutput.BaseStream, stdoutPath, timeout.Token),
        PumpAsync(process.StandardError.BaseStream, stderrPath, timeout.Token));
      pumps = output;

      await CopyInputAsync(stdinPath, process, timeout.Token);

      var exit = process.WaitForExitAsync(timeout.Token);
      var first = await Task.WhenAny(exit, output);
      if (first == output && output.IsFaulted)
      {
        TryKill(process);
        await WaitForExitAsync(process);
        await output;
      }

      await exit;
      await CompleteOutputAsync(output, process);
      stopwatch.Stop();
      return new CommandOutcome(process.ExitCode, stopwatch.ElapsedMilliseconds);
    }
    catch (Exception) when (timeout.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
    {
      // A deadline reports job.timeout; caller cancellation reports job.cancelled.
      // Both take down the whole process tree before unwinding.
      TryKill(process);
      await WaitForExitAsync(process);
      await IgnoreAsync(pumps);
      throw new OperationTimeoutException($"{spec.File}: timed out");
    }
    catch (Exception) when (cancellationToken.IsCancellationRequested)
    {
      TryKill(process);
      await WaitForExitAsync(process);
      await IgnoreAsync(pumps);
      throw new OperationCanceledException(cancellationToken);
    }
  }

  // A descendant can inherit the output pipes and keep them open. Wait a bounded
  // time, then close the read ends so completion does not depend on descendants.
  private static async Task CompleteOutputAsync(Task pumps, Process process)
  {
    if (await Task.WhenAny(pumps, Task.Delay(OutputDrainTimeout)) == pumps)
    {
      await pumps;
      return;
    }

    CloseQuietly(process.StandardOutput.BaseStream);
    CloseQuietly(process.StandardError.BaseStream);
    await IgnoreAsync(pumps);
  }

  private static async Task IgnoreAsync(Task? task)
  {
    if (task is null)
    {
      return;
    }

    try
    {
      await task;
    }
    catch (Exception)
    {
    }
  }

  private static void CloseQuietly(Stream stream)
  {
    try
    {
      stream.Dispose();
    }
    catch (Exception)
    {
    }
  }

  private static async Task CopyInputAsync(string stdinPath, Process process, CancellationToken cancellationToken)
  {
    try
    {
      await using var stdin = new FileStream(
        stdinPath,
        FileMode.Open,
        FileAccess.Read,
        FileShare.Read,
        BufferSize,
        FileOptions.Asynchronous | FileOptions.SequentialScan);

      await stdin.CopyToAsync(process.StandardInput.BaseStream, BufferSize, cancellationToken);
      process.StandardInput.Close();
    }
    catch (IOException)
    {
      // A child may exit or close stdin without reading it; that is not a job
      // failure.
    }
  }

  private static async Task PumpAsync(Stream source, string path, CancellationToken cancellationToken)
  {
    await using var destination = new FileStream(
      path,
      FileMode.Create,
      FileAccess.Write,
      FileShare.Read,
      BufferSize,
      FileOptions.Asynchronous | FileOptions.SequentialScan);

    await source.CopyToAsync(destination, BufferSize, cancellationToken);
    await destination.FlushAsync(cancellationToken);
  }

  private static void TryKill(Process process)
  {
    try
    {
      if (!process.HasExited)
      {
        process.Kill(entireProcessTree: true);
      }
    }
    catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception)
    {
    }
  }

  private static async Task WaitForExitAsync(Process process)
  {
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    try
    {
      await process.WaitForExitAsync(timeout.Token);
    }
    catch (Exception)
    {
    }
  }
}
