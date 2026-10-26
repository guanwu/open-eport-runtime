// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

using System.Net.Sockets;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace EportRuntime;

public static class Program
{
  public static async Task<int> Main(string[] args)
  {
    var identity = new AgentIdentity();

    // Registration is best effort: an agent without eport-runtime:// can still
    // serve clients that connect to it directly.
    SchemeRegistration.EnsureRegistered();

    using var shutdown = new CancellationTokenSource();
    Console.CancelKeyPress += (_, e) =>
    {
      e.Cancel = true;
      shutdown.Cancel();
    };

    var server = new AgentServer(identity.AgentHome);
    try
    {
      if (!server.TryBind())
      {
        // The first instance already serves this machine. Exit successfully so a
        // launcher or shortcut does not report an error.
        Log.Warn("another agent is already listening on 127.0.0.1:26099");
        return 0;
      }
    }
    catch (SocketException ex)
    {
      Log.Error($"could not listen on 127.0.0.1:26099: {ex.Message}");
      return 1;
    }

    try
    {
      server.PrepareHome();
    }
    catch (Exception ex)
    {
      Log.Error($"could not prepare the temp root: {ex.Message}");
      return 1;
    }

    Log.Info($"{identity} listening on ws://127.0.0.1:26099/");

    try
    {
      await server.RunAsync(shutdown.Token);
    }
    finally
    {
      await server.StopAsync();
    }

    return 0;
  }
}

public sealed class AgentIdentity
{
  public const string Name = "EportRuntime";
  public const string Version = "1.0.0";

  // Request paths and the default working directory are based here, not on
  // whatever directory the launcher used.
  public string AgentHome { get; }
  public string Platform { get; }

  public AgentIdentity()
  {
    var executable = Environment.ProcessPath;
    AgentHome = executable is null
      ? Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory)
      : Path.GetDirectoryName(executable) ?? AppContext.BaseDirectory;
    Platform = RuntimeInformation.RuntimeIdentifier;
  }

  public override string ToString() => $"{Name} {Version} ({Platform})";
}

public static class Log
{
  private static readonly object Gate = new();

  public static void Info(string message) => Write("info", message);

  public static void Warn(string message) => Write("warn", message);

  public static void Error(string message) => Write("error", message);

  // Diagnostics go to stderr; the agent writes nothing to stdout.
  private static void Write(string level, string message)
  {
    lock (Gate)
    {
      Console.Error.WriteLine($"{DateTime.UtcNow:yyyy-MM-ddTHH:mm:ss.fffZ} {level} {message}");
    }
  }
}

internal static partial class NativeMethods
{
  // 0700 on Unix; job files can contain credentials and uploaded data.
  private const uint UserReadWriteExecute = 0x1C0;

  [LibraryImport("libc", EntryPoint = "chmod", StringMarshalling = StringMarshalling.Utf8, SetLastError = true)]
  private static partial int Chmod(string path, uint mode);

  public static void SetPrivateDirectoryMode(string path)
  {
    if (OperatingSystem.IsWindows())
    {
      return;
    }

    if (Chmod(path, UserReadWriteExecute) != 0)
    {
      throw new IOException(
        $"could not restrict {path} to the current user (errno {Marshal.GetLastPInvokeError()})");
    }
  }
}

// Registers eport-runtime:// under HKCU and points it at the running executable.
// The command is refreshed on every start, so an upgraded agent keeps a working
// handler; a failure is logged and startup continues.
public static class SchemeRegistration
{
  private const string SchemeKey = @"Software\Classes\eport-runtime";

  public static void EnsureRegistered()
  {
    if (!OperatingSystem.IsWindows())
    {
      return;
    }

    var executable = Environment.ProcessPath;
    if (executable is null)
    {
      return;
    }

    try
    {
      using var key = Registry.CurrentUser.CreateSubKey(SchemeKey);
      if (key is null)
      {
        return;
      }

      key.SetValue(string.Empty, "URL:ePort Runtime");
      key.SetValue("URL Protocol", string.Empty);

      using var command = key.CreateSubKey(@"shell\open\command");
      if (command is null)
      {
        return;
      }

      var expected = $"\"{executable}\" \"%1\"";
      if (command.GetValue(string.Empty) as string != expected)
      {
        command.SetValue(string.Empty, expected);
      }
    }
    catch (Exception ex)
    {
      Log.Warn($"scheme registration failed: {ex.Message}");
    }
  }
}
