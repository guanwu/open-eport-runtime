// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

using System.Net.WebSockets;
using System.Text;

namespace EportRuntime;

// One WebSocket connection. The session validates input framing, runs at most one
// job at a time, and serialises sends so a chunk header stays adjacent to its
// Binary payload and no chunk can follow a terminal message.
public sealed class Session
{
  private const int ReceiveBufferSize = 64 * 1024;
  private const int MaxCloseReasonBytes = 123;

  private readonly AgentServer _server;
  private readonly WebSocket _socket;
  private readonly HttpSession _http = new();
  private readonly CancellationTokenSource _close = new();
  private readonly SemaphoreSlim _sendLock = new(1, 1);
  private readonly MemoryStream _text = new();
  private readonly object _state = new();

  // The job that owns the connection. A new request waits for the previous job's
  // terminal message and cleanup before it can start.
  private Job? _job;

  // A chunk header opens one Binary frame. The header marked last closes the
  // job's input after that frame.
  private bool _expectingBinary;
  private bool _chunkLast;

  private int _closing;
  private int _shutdown;

  public Session(AgentServer server, WebSocket socket)
  {
    _server = server;
    _socket = socket;
  }

  public AgentServer Server => _server;

  public HttpSession Http => _http;

  public async Task RunAsync(CancellationToken cancellationToken)
  {
    try
    {
      await ReceiveLoopAsync(cancellationToken);
    }
    catch (OperationCanceledException)
    {
    }
    catch (WebSocketException)
    {
    }
    catch (Exception ex) when (ex is IOException or ObjectDisposedException)
    {
    }
    catch (Exception ex)
    {
      Log.Error($"session failed: {ex}");
    }
    finally
    {
      await ShutdownAsync();
    }
  }

  public async Task AbortAsync() => await ShutdownAsync();

  // The send lock spans the header and its payload so no terminal message can
  // land between the two frames.
  public async Task SendChunkAsync(
    string stream,
    bool last,
    ReadOnlyMemory<byte> data,
    CancellationToken cancellationToken)
  {
    EnsureOpen();
    await _sendLock.WaitAsync(cancellationToken);
    try
    {
      EnsureOpen();
      await _socket.SendAsync(
        Wire.BuildChunk(stream, last),
        WebSocketMessageType.Text,
        endOfMessage: true,
        cancellationToken);
      await _socket.SendAsync(
        data,
        WebSocketMessageType.Binary,
        endOfMessage: true,
        cancellationToken);
    }
    finally
    {
      _sendLock.Release();
    }
  }

  public async Task SendResultAsync(byte[] result)
  {
    await SendTerminalAsync(result);
  }

  public async Task SendErrorAsync(string code, string message)
  {
    await SendTerminalAsync(Wire.BuildError(code, message));
  }

  public void FinishJob(Job job)
  {
    lock (_state)
    {
      if (ReferenceEquals(_job, job))
      {
        _job = null;
      }
    }
  }

  private async Task SendTerminalAsync(byte[] payload)
  {
    EnsureOpen();
    await _sendLock.WaitAsync(_close.Token);
    try
    {
      EnsureOpen();
      await _socket.SendAsync(
        payload,
        WebSocketMessageType.Text,
        endOfMessage: true,
        _close.Token);
    }
    finally
    {
      _sendLock.Release();
    }
  }

  private void EnsureOpen()
  {
    if (Volatile.Read(ref _closing) != 0 || Volatile.Read(ref _shutdown) != 0)
    {
      throw new OperationCanceledException();
    }
  }

  private async Task ReceiveLoopAsync(CancellationToken cancellationToken)
  {
    var buffer = new byte[ReceiveBufferSize];

    while (!cancellationToken.IsCancellationRequested && Volatile.Read(ref _closing) == 0)
    {
      var received = await _socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);

      if (received.MessageType == WebSocketMessageType.Close)
      {
        await CloseWithStatusAsync(WebSocketCloseStatus.NormalClosure, string.Empty);
        return;
      }

      if (received.MessageType == WebSocketMessageType.Binary)
      {
        if (!_expectingBinary)
        {
          await CloseWithStatusAsync(WebSocketCloseStatus.ProtocolError, "unexpected binary message");
          return;
        }

        var job = CurrentJob();
        if (job is not null && job.AcceptsInput)
        {
          await job.WriteInputAsync(buffer.AsMemory(0, received.Count), _close.Token);
        }

        if (received.EndOfMessage)
        {
          _expectingBinary = false;
          if (_chunkLast)
          {
            _chunkLast = false;
            job?.EndInput();
          }
        }

        continue;
      }

      if (_expectingBinary)
      {
        await CloseWithStatusAsync(WebSocketCloseStatus.ProtocolError, "missing binary message");
        return;
      }

      if (_text.Length + received.Count > Limits.MaxTextMessageBytes)
      {
        await CloseWithStatusAsync(WebSocketCloseStatus.MessageTooBig, "text message too large");
        return;
      }

      _text.Write(buffer, 0, received.Count);
      if (!received.EndOfMessage)
      {
        continue;
      }

      var text = _text.GetBuffer().AsMemory(0, (int)_text.Length);
      _text.SetLength(0);

      if (!ClientMessage.TryParse(text, out var message, out var malformed) || message is null)
      {
        await CloseWithStatusAsync(WebSocketCloseStatus.ProtocolError, malformed ?? "malformed message");
        return;
      }

      if (!await DispatchAsync(message))
      {
        return;
      }
    }
  }

  private async Task<bool> DispatchAsync(ClientMessage message)
  {
    switch (message.Kind)
    {
      case ClientMessageKind.Chunk:
        _expectingBinary = true;
        _chunkLast = message.Last;
        return true;

      case ClientMessageKind.Cancel:
      {
        var job = CurrentJob();
        if (job is not null && !job.TerminalSent)
        {
          job.Cancel();
        }

        return true;
      }

      case ClientMessageKind.Request:
      {
        var job = CurrentJob();
        if (job is not null)
        {
          // Producing output while a new request arrives is a protocol error.
          // Once the terminal message is sent, the new request may wait for
          // cleanup and then start.
          if (!job.TerminalSent)
          {
            await CloseWithStatusAsync(WebSocketCloseStatus.ProtocolError, "job already in flight");
            return false;
          }

          await job.Completion;
        }

        await StartJobAsync(message);
        return true;
      }

      default:
        await CloseWithStatusAsync(WebSocketCloseStatus.ProtocolError, "unknown message");
        return false;
    }
  }

  private async Task StartJobAsync(ClientMessage message)
  {
    if (!message.RequestValid || !Ops.TryParse(message.Op, out var op))
    {
      await SendErrorSafelyAsync(
        ErrorCodes.RequestInvalid,
        message.RequestValid ? $"unknown operation: {message.Op}" : "invalid request");
      return;
    }

    Job job;
    try
    {
      job = Job.Create(this, op, message.Params);
    }
    catch (ProtocolException ex)
    {
      await SendErrorSafelyAsync(ex.Code, ex.Message);
      return;
    }
    catch (EportException ex)
    {
      await SendErrorSafelyAsync(ErrorCodes.JobFailed, ex.Message);
      return;
    }
    catch (Exception ex)
    {
      Log.Error($"could not create a job: {ex}");
      await SendErrorSafelyAsync(ErrorCodes.AgentInternal, "internal error");
      return;
    }

    lock (_state)
    {
      _job = job;
    }

    job.Start();
  }

  private async Task SendErrorSafelyAsync(string code, string message)
  {
    try
    {
      await SendErrorAsync(code, message);
    }
    catch (Exception)
    {
    }
  }

  private Job? CurrentJob()
  {
    lock (_state)
    {
      return _job;
    }
  }

  private Job? TakeJob()
  {
    lock (_state)
    {
      var job = _job;
      _job = null;
      return job;
    }
  }

  private async Task CloseWithStatusAsync(WebSocketCloseStatus status, string reason)
  {
    if (Interlocked.Exchange(ref _closing, 1) != 0)
    {
      return;
    }

    CurrentJob()?.Abort();
    _close.Cancel();

    try
    {
      await _sendLock.WaitAsync();
      try
      {
        await _socket.CloseOutputAsync(
          status,
          LimitStatusDescription(reason),
          CancellationToken.None);
      }
      finally
      {
        _sendLock.Release();
      }
    }
    catch (Exception ex)
    {
      Log.Error($"could not send the close frame: {ex.Message}");
    }
  }

  // A close reason is limited to 123 UTF-8 bytes; cut at a character boundary so
  // a multi-byte character is never split.
  private static string LimitStatusDescription(string reason)
  {
    var bytes = Encoding.UTF8.GetBytes(reason);
    if (bytes.Length <= MaxCloseReasonBytes)
    {
      return reason;
    }

    var length = MaxCloseReasonBytes;
    while (length > 0 && (bytes[length] & 0xC0) == 0x80)
    {
      length--;
    }

    return Encoding.UTF8.GetString(bytes, 0, length);
  }

  // Runs once. It aborts the job, gives cleanup five seconds, then disposes the
  // HTTP client, the socket, and the session's synchronization objects.
  private async Task ShutdownAsync()
  {
    if (Interlocked.Exchange(ref _shutdown, 1) != 0)
    {
      return;
    }

    Volatile.Write(ref _closing, 1);
    _close.Cancel();

    var job = TakeJob();
    if (job is not null)
    {
      job.Abort();
      try
      {
        await job.Completion.WaitAsync(TimeSpan.FromSeconds(5));
      }
      catch (Exception)
      {
      }
    }

    _http.Dispose();

    try
    {
      _socket.Dispose();
    }
    catch (Exception)
    {
    }

    _sendLock.Dispose();
    _close.Dispose();
  }
}
