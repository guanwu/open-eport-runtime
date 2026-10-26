// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;

namespace EportRuntime;

public sealed record HttpRequestSpec(
  string Url,
  string Method,
  IReadOnlyDictionary<string, string[]> Headers,
  int TimeoutMs);

public sealed record HttpResult(
  int Status,
  IReadOnlyDictionary<string, string[]> Headers,
  long Size,
  long DurationMs);

public sealed record CookieRecord(
  string Name,
  string Value,
  string? Domain,
  string Path,
  bool Secure,
  bool HttpOnly,
  long? ExpiresMs);

// Converts between wire cookie records and System.Net.Cookie. Constructing a
// Cookie validates the name, value, domain, and expiry; the codec adds the path
// and date-range checks the wire format needs.
public static class CookieCodec
{
  public static CookieRecord Create(
    string name,
    string value,
    string? domain,
    string path,
    bool secure,
    bool httpOnly,
    long? expiresMs)
  {
    _ = new Cookie(name, value);

    if (string.IsNullOrEmpty(domain))
    {
      domain = null;
    }

    if (string.IsNullOrEmpty(path))
    {
      path = "/";
    }

    if (!path.StartsWith('/'))
    {
      throw new CookieException("cookie path must start with '/'");
    }

    if (expiresMs is long milliseconds)
    {
      _ = DateTimeOffset.FromUnixTimeMilliseconds(milliseconds);
    }

    return new CookieRecord(name, value, domain, path, secure, httpOnly, expiresMs);
  }

  public static void Validate(IReadOnlyList<CookieRecord> records)
  {
    var container = new CookieContainer();
    foreach (var record in records)
    {
      if (record.Domain is null)
      {
        _ = new Cookie(record.Name, record.Value);
        continue;
      }

      container.Add(ToCookie(record));
    }
  }

  public static Cookie ToCookie(CookieRecord record)
  {
    var cookie = new Cookie(record.Name, record.Value)
    {
      Domain = record.Domain ?? string.Empty,
      Path = record.Path,
      Secure = record.Secure,
      HttpOnly = record.HttpOnly,
    };

    if (record.ExpiresMs is long milliseconds)
    {
      cookie.Expires = DateTimeOffset.FromUnixTimeMilliseconds(milliseconds).UtcDateTime;
    }

    return cookie;
  }

  public static CookieRecord FromCookie(Cookie cookie)
  {
    long? expiresMs = null;
    if (cookie.Expires != DateTime.MinValue)
    {
      expiresMs = new DateTimeOffset(cookie.Expires.ToUniversalTime()).ToUnixTimeMilliseconds();
    }

    return new CookieRecord(
      cookie.Name,
      cookie.Value,
      string.IsNullOrEmpty(cookie.Domain) ? null : cookie.Domain,
      string.IsNullOrEmpty(cookie.Path) ? "/" : cookie.Path,
      cookie.Secure,
      cookie.HttpOnly,
      expiresMs);
  }

  public static bool IsExpired(CookieRecord record, long nowMs) =>
    record.ExpiresMs is long expiresMs && expiresMs <= nowMs;

  public static bool MatchesHostless(CookieRecord record, Uri uri, long nowMs)
  {
    if (IsExpired(record, nowMs))
    {
      return false;
    }

    if (record.Secure && uri.Scheme != Uri.UriSchemeHttps)
    {
      return false;
    }

    return PathMatches(record.Path, uri.AbsolutePath);
  }

  public static bool PathMatches(string cookiePath, string requestPath)
  {
    if (string.IsNullOrEmpty(cookiePath))
    {
      cookiePath = "/";
    }

    if (requestPath == cookiePath)
    {
      return true;
    }

    if (!requestPath.StartsWith(cookiePath, StringComparison.Ordinal))
    {
      return false;
    }

    return cookiePath.EndsWith('/') || requestPath[cookiePath.Length] == '/';
  }
}

// Domain cookies are held by CookieContainer. Cookies with no domain are kept in
// a separate list because CookieContainer cannot represent them; they match
// every host, since the wire format gives them no host scope.
public sealed class CookieJar
{
  private CookieContainer _container = new();
  private List<CookieRecord> _hostless = new();

  public void Replace(IReadOnlyList<CookieRecord> records)
  {
    var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    var container = new CookieContainer();
    var hostless = new List<CookieRecord>();

    foreach (var record in records)
    {
      if (CookieCodec.IsExpired(record, now))
      {
        continue;
      }

      if (record.Domain is null)
      {
        hostless.Add(record);
        continue;
      }

      container.Add(CookieCodec.ToCookie(record));
    }

    _container = container;
    _hostless = hostless;
  }

  public string? Header(Uri uri)
  {
    var parts = new List<string>();
    var header = _container.GetCookieHeader(uri);
    if (!string.IsNullOrEmpty(header))
    {
      parts.Add(header);
    }

    var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    foreach (var record in _hostless)
    {
      if (CookieCodec.MatchesHostless(record, uri, now))
      {
        parts.Add($"{record.Name}={record.Value}");
      }
    }

    return parts.Count == 0 ? null : string.Join("; ", parts);
  }

  public void Store(Uri uri, string setCookieHeader)
  {
    try
    {
      _container.SetCookies(uri, setCookieHeader);
    }
    catch (CookieException)
    {
    }
  }

  public IReadOnlyList<CookieRecord> Snapshot()
  {
    var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    var records = new List<CookieRecord>();

    foreach (Cookie cookie in _container.GetAllCookies())
    {
      var record = CookieCodec.FromCookie(cookie);
      if (!CookieCodec.IsExpired(record, now))
      {
        records.Add(record);
      }
    }

    foreach (var record in _hostless)
    {
      if (!CookieCodec.IsExpired(record, now))
      {
        records.Add(record);
      }
    }

    return records;
  }
}

// One HTTP client and cookie jar per connection. Redirects are followed by hand
// so method, body, and credentials follow the protocol rules, and response
// bodies are staged on disk instead of memory.
public sealed class HttpSession : IDisposable
{
  private const int BufferSize = 64 * 1024;

  private readonly HttpClient _client;
  private readonly CookieJar _cookies = new();

  public HttpSession()
  {
    var handler = new SocketsHttpHandler
    {
      UseCookies = false,
      AllowAutoRedirect = false,
      AutomaticDecompression = DecompressionMethods.All,
      UseProxy = true,
    };

    handler.SslOptions.RemoteCertificateValidationCallback = static (_, _, _, _) => true;
    _client = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
  }

  public IReadOnlyList<CookieRecord> GetCookies() => _cookies.Snapshot();

  public void SetCookies(IReadOnlyList<CookieRecord> records) => _cookies.Replace(records);

  public async Task<HttpResult> SendAsync(
    HttpRequestSpec spec,
    string bodyPath,
    string responsePath,
    CancellationToken cancellationToken)
  {
    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
    if (spec.TimeoutMs > 0)
    {
      timeout.CancelAfter(spec.TimeoutMs);
    }

    var token = timeout.Token;
    var stopwatch = Stopwatch.StartNew();
    var uri = new Uri(spec.Url, UriKind.Absolute);
    var method = new HttpMethod(spec.Method);
    var bodyLength = new FileInfo(bodyPath).Length;
    var hasBody = bodyLength > 0 || (method != HttpMethod.Get && method != HttpMethod.Head);
    var redirects = 0;

    try
    {
      while (true)
      {
        using var request = new HttpRequestMessage(method, uri);
        if (hasBody)
        {
          AttachBody(request, bodyPath, bodyLength);
        }

        ApplyHeaders(request, spec.Headers, redirects > 0);
        ApplyCookies(request, uri);

        using var response = await _client.SendAsync(
          request,
          HttpCompletionOption.ResponseHeadersRead,
          token);

        StoreCookies(uri, response);

        if (TryGetRedirect(response, uri, method, redirects, out var nextUri, out var nextMethod))
        {
          redirects++;
          uri = nextUri;
          method = nextMethod;
          hasBody = method != HttpMethod.Get && method != HttpMethod.Head;
          continue;
        }

        var headers = CollectHeaders(response);
        var size = await StageBodyAsync(response, responsePath, token);
        stopwatch.Stop();

        return new HttpResult(
          (int)response.StatusCode,
          headers,
          size,
          stopwatch.ElapsedMilliseconds);
      }
    }
    catch (OperationCanceledException)
    {
      if (cancellationToken.IsCancellationRequested)
      {
        throw;
      }

      if (timeout.IsCancellationRequested)
      {
        throw new OperationTimeoutException("HTTP request timed out");
      }

      throw;
    }
    catch (HttpRequestException ex)
    {
      throw new EportException(ex.Message);
    }
    catch (IOException ex)
    {
      throw new EportException(ex.Message);
    }
    catch (InvalidOperationException ex)
    {
      throw new EportException(ex.Message);
    }
  }

  public void Dispose() => _client.Dispose();

  private static void AttachBody(HttpRequestMessage request, string bodyPath, long bodyLength)
  {
    if (bodyLength == 0)
    {
      request.Content = new ByteArrayContent(Array.Empty<byte>());
      return;
    }

    var body = new FileStream(
      bodyPath,
      FileMode.Open,
      FileAccess.Read,
      FileShare.Read,
      BufferSize,
      FileOptions.Asynchronous | FileOptions.SequentialScan);

    var content = new StreamContent(body, BufferSize);
    content.Headers.ContentLength = bodyLength;
    request.Content = content;
  }

  private static void ApplyHeaders(
    HttpRequestMessage request,
    IReadOnlyDictionary<string, string[]> headers,
    bool isRedirect)
  {
    foreach (var (name, values) in headers)
    {
      if (isRedirect &&
          (name.Equals("Authorization", StringComparison.OrdinalIgnoreCase) ||
           name.Equals("ProxyAuthorization", StringComparison.OrdinalIgnoreCase)))
      {
        // A redirect may cross origins, so credentials are not forwarded.
        continue;
      }

      // Framing headers belong to the client. Cookie is added after the jar so a
      // caller-supplied Cookie can be merged with stored cookies.
      if (name.Equals("Content-Length", StringComparison.OrdinalIgnoreCase) ||
          name.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase) ||
          name.Equals("Cookie", StringComparison.OrdinalIgnoreCase))
      {
        continue;
      }

      if (request.Headers.TryAddWithoutValidation(name, values))
      {
        continue;
      }

      if (request.Content is not null &&
          request.Content.Headers.TryAddWithoutValidation(name, values))
      {
        continue;
      }

      // When a redirect turns the request into a body-less GET, content headers
      // are dropped too.
      if (isRedirect && request.Content is null)
      {
        continue;
      }

      throw new EportException($"invalid header: {name}");
    }

    if (headers.TryGetValue("Cookie", out var cookieValues))
    {
      foreach (var value in cookieValues)
      {
        request.Headers.TryAddWithoutValidation("Cookie", value);
      }
    }
  }

  private void ApplyCookies(HttpRequestMessage request, Uri uri)
  {
    var fromJar = _cookies.Header(uri);
    if (fromJar is null)
    {
      return;
    }

    var existing = request.Headers.TryGetValues("Cookie", out var values)
      ? string.Join("; ", values)
      : null;

    request.Headers.Remove("Cookie");
    request.Headers.TryAddWithoutValidation(
      "Cookie",
      existing is null ? fromJar : existing + "; " + fromJar);
  }

  private void StoreCookies(Uri uri, HttpResponseMessage response)
  {
    if (!response.Headers.TryGetValues("Set-Cookie", out var setCookies))
    {
      return;
    }

    foreach (var value in setCookies)
    {
      _cookies.Store(uri, value);
    }
  }

  // A redirect is followed only when the limit is not reached, a Location exists,
  // and the target is HTTP(S). HTTPS never downgrades to HTTP.
  private static bool TryGetRedirect(
    HttpResponseMessage response,
    Uri current,
    HttpMethod currentMethod,
    int redirects,
    out Uri next,
    out HttpMethod method)
  {
    next = current;
    method = currentMethod;

    if (redirects >= Limits.MaxRedirects ||
        response.Headers.Location is not { } location ||
        !IsRedirect(response.StatusCode) ||
        !Uri.TryCreate(current, location, out var candidate))
    {
      return false;
    }

    if (candidate.Scheme != Uri.UriSchemeHttp && candidate.Scheme != Uri.UriSchemeHttps)
    {
      return false;
    }

    if (current.Scheme == Uri.UriSchemeHttps && candidate.Scheme == Uri.UriSchemeHttp)
    {
      return false;
    }

    // 303, and POST after 301/302, continue as a body-less GET; other redirects
    // keep the method and resend the body.
    method = response.StatusCode switch
    {
      HttpStatusCode.SeeOther when currentMethod != HttpMethod.Head => HttpMethod.Get,
      HttpStatusCode.MovedPermanently or HttpStatusCode.Found when currentMethod == HttpMethod.Post => HttpMethod.Get,
      _ => currentMethod,
    };

    next = candidate;
    return true;
  }

  private static bool IsRedirect(HttpStatusCode status) => status is
    HttpStatusCode.MovedPermanently or
    HttpStatusCode.Found or
    HttpStatusCode.SeeOther or
    HttpStatusCode.TemporaryRedirect or
    HttpStatusCode.PermanentRedirect;

  private static async Task<long> StageBodyAsync(
    HttpResponseMessage response,
    string responsePath,
    CancellationToken cancellationToken)
  {
    await using var output = new FileStream(
      responsePath,
      FileMode.Create,
      FileAccess.Write,
      FileShare.Read,
      BufferSize,
      FileOptions.Asynchronous | FileOptions.SequentialScan);

    await using var source = await response.Content.ReadAsStreamAsync(cancellationToken);
    await source.CopyToAsync(output, BufferSize, cancellationToken);
    await output.FlushAsync(cancellationToken);

    return output.Length;
  }

  private static IReadOnlyDictionary<string, string[]> CollectHeaders(HttpResponseMessage response)
  {
    var groups = new SortedDictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);

    AddHeaders(groups, response.Headers);
    AddHeaders(groups, response.Content.Headers);

    var result = new Dictionary<string, string[]>(StringComparer.Ordinal);
    foreach (var (name, values) in groups)
    {
      result[name.ToLowerInvariant()] = values.ToArray();
    }

    return result;
  }

  private static void AddHeaders(
    SortedDictionary<string, List<string>> groups,
    HttpHeaders headers)
  {
    foreach (var (name, values) in headers)
    {
      if (!groups.TryGetValue(name, out var list))
      {
        list = new List<string>();
        groups[name] = list;
      }

      list.AddRange(values);
    }
  }
}
