// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

using System.Collections.Concurrent;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;

namespace EportRuntime;

// Owns the loopback listener, the shared services, and the live sessions. All
// connections share one card slot, one path resolver, and one temp root.
public sealed class AgentServer
{
  public const int Port = 26099;

  private readonly TcpListener _listener = new(IPAddress.Loopback, Port);

  // Live sessions, kept only so shutdown can abort every connection.
  private readonly ConcurrentDictionary<Session, byte> _sessions = new();

  public PathResolver Resolver { get; }
  public CommandRunner Commands { get; } = new();
  public CardService Cards { get; } = new();
  public string TempRoot { get; }

  public AgentServer(string agentHome)
  {
    Resolver = new PathResolver(agentHome);
    TempRoot = Path.Combine(Path.GetTempPath(), "eport-runtime");
  }

  public bool TryBind()
  {
    try
    {
      _listener.Start();
      return true;
    }
    catch (SocketException ex) when (ex.SocketErrorCode == SocketError.AddressAlreadyInUse)
    {
      return false;
    }
  }

  public void PrepareHome()
  {
    try
    {
      // A crash can leave job directories behind. Delete them before the first
      // connection so no request can observe or resume them.
      if (Directory.Exists(TempRoot))
      {
        Directory.Delete(TempRoot, recursive: true);
      }
    }
    catch (Exception ex)
    {
      Log.Warn($"could not reset the temp root: {ex.Message}");
    }

    Directory.CreateDirectory(TempRoot);
    NativeMethods.SetPrivateDirectoryMode(TempRoot);
  }

  public string CreateJobDirectory()
  {
    var id = Convert.ToHexString(RandomNumberGenerator.GetBytes(8)).ToLowerInvariant();
    var directory = Path.Combine(TempRoot, id);
    Directory.CreateDirectory(directory);
    NativeMethods.SetPrivateDirectoryMode(directory);
    return directory;
  }

  public async Task RunAsync(CancellationToken cancellationToken)
  {
    while (!cancellationToken.IsCancellationRequested)
    {
      TcpClient client;
      try
      {
        client = await _listener.AcceptTcpClientAsync(cancellationToken);
      }
      catch (OperationCanceledException)
      {
        break;
      }
      catch (SocketException ex)
      {
        if (cancellationToken.IsCancellationRequested)
        {
          break;
        }

        Log.Warn($"accept failed: {ex.Message}");
        continue;
      }

      client.NoDelay = true;

      // Run the connection on its own task; the accept loop must not wait for a
      // session to finish.
      _ = HandleClientAsync(client, cancellationToken);
    }
  }

  public async Task StopAsync()
  {
    _listener.Stop();

    var sessions = _sessions.Keys.ToArray();
    await Task.WhenAll(sessions.Select((session) => session.AbortAsync()));
  }

  private async Task HandleClientAsync(TcpClient client, CancellationToken cancellationToken)
  {
    using var connection = client;
    Session? session = null;

    try
    {
      var stream = client.GetStream();
      using var handshake = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
      handshake.CancelAfter(TimeSpan.FromSeconds(30));

      var socket = await WebSocketUpgrade.TryUpgradeAsync(stream, handshake.Token);
      if (socket is null)
      {
        return;
      }

      session = new Session(this, socket);
      _sessions[session] = 0;
      await session.RunAsync(cancellationToken);
    }
    catch (Exception ex) when (ex is IOException or SocketException or OperationCanceledException)
    {
    }
    catch (Exception ex)
    {
      Log.Error($"connection failed: {ex}");
    }
    finally
    {
      if (session is not null)
      {
        _sessions.TryRemove(session, out _);
      }
    }
  }
}

// A minimal HTTP/1.1 upgrade for exactly GET / and eport-runtime.v1. Doing the
// handshake directly avoids an HTTP server stack and makes a missing or wrong
// subprotocol a 400 instead of a silent fallback.
public static class WebSocketUpgrade
{
  private const int MaxHeaderBytes = 16 * 1024;
  private const string WebSocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  private const string Subprotocol = "eport-runtime.v1";

  public static async Task<WebSocket?> TryUpgradeAsync(
    Stream stream,
    CancellationToken cancellationToken)
  {
    // Read one byte at a time and stop at CRLFCRLF: a buffered read could consume
    // bytes of the first WebSocket frame. Headers beyond 16 KiB are rejected.
    var header = new byte[MaxHeaderBytes];
    var length = 0;

    while (true)
    {
      var read = await stream.ReadAsync(header.AsMemory(length, 1), cancellationToken);
      if (read == 0)
      {
        return null;
      }

      length++;
      if (length >= 4 &&
          header[length - 4] == '\r' &&
          header[length - 3] == '\n' &&
          header[length - 2] == '\r' &&
          header[length - 1] == '\n')
      {
        break;
      }

      if (length == header.Length)
      {
        await WriteBadRequestAsync(stream, cancellationToken);
        return null;
      }
    }

    var text = Encoding.ASCII.GetString(header, 0, length);
    var lines = text.Split("\r\n", StringSplitOptions.None);
    var requestLine = lines[0].Split(' ', StringSplitOptions.RemoveEmptyEntries);
    if (requestLine.Length != 3 ||
        requestLine[0] != "GET" ||
        requestLine[1] != "/" ||
        requestLine[2] != "HTTP/1.1")
    {
      await WriteBadRequestAsync(stream, cancellationToken);
      return null;
    }

    var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    foreach (var line in lines.Skip(1))
    {
      if (line.Length == 0)
      {
        continue;
      }

      var separator = line.IndexOf(':');
      if (separator <= 0)
      {
        await WriteBadRequestAsync(stream, cancellationToken);
        return null;
      }

      var name = line[..separator].Trim();
      var value = line[(separator + 1)..].Trim();
      headers[name] = headers.TryGetValue(name, out var existing)
        ? existing + ", " + value
        : value;
    }

    // Upgrade, version, key, and subprotocol are all mandatory. Anything else is
    // a bad request, never a downgrade.
    if (!HasToken(headers, "Upgrade", "websocket") ||
        !HasToken(headers, "Connection", "Upgrade") ||
        !headers.TryGetValue("Sec-WebSocket-Version", out var version) ||
        version != "13" ||
        !headers.TryGetValue("Sec-WebSocket-Key", out var key) ||
        !OffersSubprotocol(headers))
    {
      await WriteBadRequestAsync(stream, cancellationToken);
      return null;
    }

    var accept = Convert.ToBase64String(
      SHA1.HashData(Encoding.ASCII.GetBytes(key + WebSocketGuid)));

    var response = string.Concat(
      "HTTP/1.1 101 Switching Protocols\r\n",
      "Upgrade: websocket\r\n",
      "Connection: Upgrade\r\n",
      "Sec-WebSocket-Accept: ", accept, "\r\n",
      $"Sec-WebSocket-Protocol: {Subprotocol}\r\n",
      "\r\n");

    await stream.WriteAsync(Encoding.ASCII.GetBytes(response), cancellationToken);
    await stream.FlushAsync(cancellationToken);

    return WebSocket.CreateFromStream(
      stream,
      new WebSocketCreationOptions
      {
        IsServer = true,
        SubProtocol = Subprotocol,
        KeepAliveInterval = TimeSpan.Zero,
      });
  }

  private static bool OffersSubprotocol(Dictionary<string, string> headers)
  {
    if (!headers.TryGetValue("Sec-WebSocket-Protocol", out var offered))
    {
      return false;
    }

    foreach (var protocol in offered.Split(','))
    {
      if (protocol.Trim() == Subprotocol)
      {
        return true;
      }
    }

    return false;
  }

  private static bool HasToken(Dictionary<string, string> headers, string name, string token)
  {
    if (!headers.TryGetValue(name, out var value))
    {
      return false;
    }

    foreach (var part in value.Split(','))
    {
      if (part.Trim().Equals(token, StringComparison.OrdinalIgnoreCase))
      {
        return true;
      }
    }

    return false;
  }

  private static async Task WriteBadRequestAsync(Stream stream, CancellationToken cancellationToken)
  {
    const string response =
      "HTTP/1.1 400 Bad Request\r\n" +
      "Content-Length: 0\r\n" +
      "Connection: close\r\n" +
      "\r\n";

    try
    {
      await stream.WriteAsync(Encoding.ASCII.GetBytes(response), cancellationToken);
      await stream.FlushAsync(cancellationToken);
    }
    catch (Exception)
    {
    }
  }
}
