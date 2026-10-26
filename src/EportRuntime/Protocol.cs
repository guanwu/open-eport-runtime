// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

using System.Buffers;
using System.Text.Json;

namespace EportRuntime;

public static class ErrorCodes
{
  public const string RequestInvalid = "request.invalid";
  public const string JobCancelled = "job.cancelled";
  public const string JobTimeout = "job.timeout";
  public const string JobFailed = "job.failed";
  public const string AgentInternal = "agent.internal";
  public const string CardNotFound = "card.notFound";
  public const string CardMismatch = "card.mismatch";
  public const string CardPinRejected = "card.pinRejected";
  public const string CardPinRequired = "card.pinRequired";
  public const string CardFailed = "card.failed";
}

public static class Limits
{
  // A single Text message larger than this closes the connection with 1009.
  public const int MaxTextMessageBytes = 1024 * 1024;
  public const int MaxRedirects = 50;
  public const int DefaultHttpTimeoutMs = 60_000;
  public const int MaxCardTextBytes = 1024;
  public const int CardPinBytes = 8;
}

// A capability failure; the job ends with job.failed and this message.
public class EportException : Exception
{
  public EportException(string message) : base(message)
  {
  }
}

// A failure that ends the job with a specific protocol code.
public sealed class ProtocolException : Exception
{
  public string Code { get; }

  public ProtocolException(string code, string message) : base(message)
  {
    Code = code;
  }
}

// A deadline elapsed; the job ends with job.timeout rather than job.cancelled.
public sealed class OperationTimeoutException : Exception
{
  public OperationTimeoutException(string message) : base(message)
  {
  }
}

public enum Op
{
  ExecRun,
  FsList,
  FsRead,
  FsWrite,
  FsDelete,
  FsStat,
  HttpRequest,
  HttpCookiesGet,
  HttpCookiesSet,
  CardList,
  CardVerify,
  CardSign,
}

public static class Ops
{
  public static bool TryParse(string name, out Op op)
  {
    switch (name)
    {
      case "exec.run": op = Op.ExecRun; return true;
      case "fs.list": op = Op.FsList; return true;
      case "fs.read": op = Op.FsRead; return true;
      case "fs.write": op = Op.FsWrite; return true;
      case "fs.delete": op = Op.FsDelete; return true;
      case "fs.stat": op = Op.FsStat; return true;
      case "http.request": op = Op.HttpRequest; return true;
      case "http.cookies.get": op = Op.HttpCookiesGet; return true;
      case "http.cookies.set": op = Op.HttpCookiesSet; return true;
      case "card.list": op = Op.CardList; return true;
      case "card.verify": op = Op.CardVerify; return true;
      case "card.sign": op = Op.CardSign; return true;
      default: op = default; return false;
    }
  }
}

public enum ClientMessageKind
{
  Request,
  Chunk,
  Cancel,
}

// A parsed Text frame. JSON syntax and the envelope are checked here; a request
// with missing or mistyped fields is still returned with RequestValid = false,
// so the session can answer request.invalid instead of closing the connection.
public sealed class ClientMessage
{
  public ClientMessageKind Kind { get; private init; }
  public string Op { get; private init; } = string.Empty;
  public bool RequestValid { get; private init; } = true;
  public JsonElement Params { get; private init; }
  public bool Last { get; private init; }

  public static bool TryParse(ReadOnlyMemory<byte> utf8, out ClientMessage? message, out string? malformed)
  {
    message = null;
    malformed = null;

    try
    {
      using var document = JsonDocument.Parse(utf8);
      var root = document.RootElement;
      if (root.ValueKind != JsonValueKind.Object ||
          !root.TryGetProperty("type", out var typeElement) ||
          typeElement.ValueKind != JsonValueKind.String)
      {
        malformed = "message must be an object with a string type";
        return false;
      }

      switch (typeElement.GetString())
      {
        case "request":
        {
          var valid = true;
          var op = string.Empty;
          if (!root.TryGetProperty("op", out var opElement) || opElement.ValueKind != JsonValueKind.String)
          {
            valid = false;
          }
          else
          {
            op = opElement.GetString() ?? string.Empty;
          }

          var parameters = default(JsonElement);
          if (root.TryGetProperty("params", out var paramsElement))
          {
            if (paramsElement.ValueKind != JsonValueKind.Object)
            {
              valid = false;
            }
            else
            {
              parameters = paramsElement.Clone();
            }
          }

          message = new ClientMessage
          {
            Kind = ClientMessageKind.Request,
            Op = op,
            RequestValid = valid,
            Params = parameters,
          };
          return true;
        }

        case "chunk":
          if (!root.TryGetProperty("last", out var lastElement) ||
              lastElement.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
          {
            malformed = "chunk.last must be a boolean";
            return false;
          }

          message = new ClientMessage
          {
            Kind = ClientMessageKind.Chunk,
            Last = lastElement.GetBoolean(),
          };
          return true;

        case "cancel":
          message = new ClientMessage { Kind = ClientMessageKind.Cancel };
          return true;

        default:
          malformed = "unknown message type";
          return false;
      }
    }
    catch (JsonException ex)
    {
      malformed = ex.Message;
      return false;
    }
  }
}

// Builds server Text frames. Result and error frames are single JSON objects;
// JSON Lines are newline-terminated so entry streams can split anywhere.
public static class Wire
{
  public static byte[] BuildChunk(string stream, bool last) => Build(writer =>
  {
    writer.WriteStartObject();
    writer.WriteString("type", "chunk");
    writer.WriteString("stream", stream);
    writer.WriteBoolean("last", last);
    writer.WriteEndObject();
  });

  public static byte[] BuildResult(Action<Utf8JsonWriter> writeResult) => Build(writer =>
  {
    writer.WriteStartObject();
    writer.WriteString("type", "result");
    writer.WritePropertyName("result");
    writer.WriteStartObject();
    writeResult(writer);
    writer.WriteEndObject();
    writer.WriteEndObject();
  });

  public static byte[] BuildError(string code, string message) => Build(writer =>
  {
    writer.WriteStartObject();
    writer.WriteString("type", "error");
    writer.WriteString("code", code);
    writer.WriteString("message", message);
    writer.WriteEndObject();
  });

  public static byte[] BuildJsonLine(Action<Utf8JsonWriter> writeObject) => Build(writer =>
  {
    writer.WriteStartObject();
    writeObject(writer);
    writer.WriteEndObject();
  }, appendNewLine: true);

  private static byte[] Build(Action<Utf8JsonWriter> write, bool appendNewLine = false)
  {
    var buffer = new ArrayBufferWriter<byte>(256);
    using (var writer = new Utf8JsonWriter(buffer))
    {
      write(writer);
    }

    if (!appendNewLine)
    {
      return buffer.WrittenSpan.ToArray();
    }

    var withLine = new byte[buffer.WrittenCount + 1];
    buffer.WrittenSpan.CopyTo(withLine);
    withLine[^1] = (byte)'\n';
    return withLine;
  }
}
