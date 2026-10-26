# Open ePort Runtime Wire Protocol

Version 1 (`eport-runtime.v1`).

This document defines the wire protocol and runtime behaviour.

## 1. Overview

One WebSocket connection to `ws://127.0.0.1:26099/` gives the client four capability groups:

- `exec.run` — run an executable installed on the machine;
- `fs.list` / `fs.read` / `fs.write` / `fs.delete` / `fs.stat` — local files;
- `http.request` + `http.cookies.get` / `set` — HTTP with a per-connection cookie jar;
- `card.list` / `card.verify` / `card.sign` — ePort smart cards.

The protocol is a job runner. A client submits one request, streams the request's input, the agent executes and stages the output, then streams the output back. A connection carries one job at a time.

### 1.1 Fixed properties

| Property | Value |
|---|---|
| Endpoint | `ws://127.0.0.1:26099/`, loopback only |
| Subprotocol | `eport-runtime.v1` |
| Message kinds | Text (UTF-8 JSON), Binary (opaque bytes) |
| Jobs per connection | 1 |
| Card jobs per agent | 1 |
| Terminal messages per request | 1 |

Failing to bind `127.0.0.1:26099` means another agent is running; the process exits with code 0.

### 1.2 Rules

1. Text carries structure; Binary carries bytes.
2. Every Binary message belongs to the Text message immediately before it.
3. A stream is complete only when it ends with `last: true`.
4. Every request ends with exactly one `result` or `error`.
5. Input is written to disk as it arrives; output is read from disk as it is sent.

### 1.3 Terms

- **Client** — the page or process that opens the connection.
- **Agent** — the process implementing this protocol.
- **Request** — the `request` message that starts a job.
- **Job** — the unit of work created by a request, with one input stream and zero or more output streams.
- **Operation** — one of the twelve capabilities in §5.
- **Stream** — a sequence of chunks ending with `last: true`. Output streams carry a `stream` name; the input stream does not.
- **Chunk** — one `chunk` Text message plus the Binary message that follows it.
- **Terminal message** — `result` or `error`; exactly one per request.

## 2. Transport

### 2.1 Upgrade

The client opens `ws://127.0.0.1:26099/` and offers the subprotocol `eport-runtime.v1`. The server selects it. If the client offers no subprotocol, or does not offer `eport-runtime.v1`, the server responds `400 Bad Request` and does not upgrade.

Any client that reaches the endpoint is accepted.

### 2.2 Message kinds and size

Text messages are valid UTF-8 JSON objects. Binary messages are opaque bytes.

A Text message larger than 1 MiB closes the connection with code 1009. Binary messages are streamed; their size is bounded by disk and connection.

WebSocket fragmentation is invisible to this protocol: a message means one complete WebSocket message.

### 2.3 Pairing

Every `chunk` message is followed by exactly one Binary message. Only a `chunk` message is followed by a Binary message. The Binary message carries payload bytes only; the preceding `chunk` header describes them.

A violation closes the connection with code 1002.

## 3. Messages

Five `type` values: `request`, `chunk`, `cancel`, `result`, `error`.

### 3.1 Client to server

#### `request`

```json
{"type":"request","op":"fs.write","params":{"path":"out/a.bin"}}
```

| Field | Type | Meaning |
|---|---|---|
| `op` | string | One of §5. |
| `params` | object | Operation parameters. Unknown fields are ignored. |

A valid `request` creates the job and enters `ingesting`; an invalid `request` is answered with `error` code `request.invalid` and leaves the connection idle. A `request` received while a job is in flight is a protocol violation; the connection closes with code 1002.

#### `chunk`

```json
{"type":"chunk","last":false}
```

Followed by exactly one Binary message.

| Field | Type | Meaning |
|---|---|---|
| `last` | boolean | Ends the input stream. |

The final input chunk carries `last: true` and may carry an empty Binary message. Every request has exactly one input terminator, including requests that take no input.

Input chunks received after the terminator, or while the connection is idle, are late and are discarded together with their Binary message.

#### `cancel`

```json
{"type":"cancel"}
```

The current job is aborted and its terminal message is the answer. A `cancel` received while the connection is idle is ignored.

### 3.2 Server to client

#### `chunk`

```json
{"type":"chunk","stream":"stdout","last":false}
```

Followed by exactly one Binary message.

| Field | Type | Meaning |
|---|---|---|
| `stream` | string | Operation-defined output name (§5). |
| `last` | boolean | Ends this output stream. |

Rules:

- A stream that appears ends with `last: true`.
- Chunks of different streams are never interleaved; each stream's chunks are contiguous.
- A stream is opened only when it has data.
- All streams end before the terminal message.
- A stream that does not end with `last` is incomplete; the client treats its content as failed output.

#### `result`

```json
{"type":"result","result":{"path":"out/a.bin","size":131072}}
```

Terminal. `result` is an operation-defined object (§5). A non-zero process exit code, an HTTP 4xx/5xx, and a 3xx that is not followed are results.

#### `error`

```json
{"type":"error","code":"job.failed","message":"out/a.bin: not found"}
```

Terminal. `code` is one of §6; `message` is human-readable and not stable.

## 4. Lifecycle

```
              request
   idle ─────────────────▶ ingesting
     ▲                        │  last: true
     │                        ▼
     │                      running
     │                        │
     └────── terminal ◀───────┘
        result / error, at any stage
```

1. The connection starts `idle`.
2. `request` creates the job, its temp directory, and the operation's input sink.
3. Input chunks are written to the sink until `last`.
4. The operation runs. Output streams may be sent while it runs or after it ends, as each operation specifies.
5. Exactly one terminal message ends the job. The connection returns to `idle`; a new `request` starts the next job, and other messages received while idle are discarded.
6. Closing the connection aborts the job: process trees are killed, HTTP requests are aborted, temp files are deleted.

A terminal message may arrive at any time, including while the client is sending input. The client stops sending and discards its unread input.

## 5. Operations

Relative paths resolve against AgentHome, the agent executable's directory. Absolute paths are used as given. AgentHome is the default working directory and the first command lookup location. A malformed path is `request.invalid`; a well-formed path that does not exist is `job.failed`.

### 5.1 `exec.run`

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `file` | string | required | Executable. A name without a path separator is looked up in AgentHome, then `PATH`; a relative path resolves against AgentHome. |
| `args` | string[] | `[]` | Arguments, passed as a vector. |
| `cwd` | string | AgentHome | Working directory. |
| `env` | object | `{}` | Environment overlay on the inherited environment. |
| `timeoutMs` | number | `0` | Operation limit; starts after the input terminator; `0` means none. |

- The job's input is passed as stdin. An empty input is an empty file.
- Output streams `stdout` and `stderr`, each sent if non-empty, `stdout` first.
- `result`: `{"exitCode":0,"durationMs":123}`.
- Errors: `request.invalid`, `job.failed`, `job.timeout`, `job.cancelled`.

The executable runs directly with an argument vector. `.bat` and `.cmd` files are never executed implicitly. The process tree is killed on cancellation, timeout, and connection close.

Output is captured to files and sent after the process exits. Each stream is read from its file in chunks while it is sent. Streams are sent one after the other, `stdout` first; the original interleaving is not preserved.

### 5.2 `fs.read`

| Argument | Type | Meaning |
|---|---|---|
| `path` | string | File to read. |

- Output stream `content`.
- `result`: `{"size":131072}`.
- Errors: `request.invalid`, `job.failed`.

The file is streamed as it is read. A read error mid-stream ends the stream without `last` and is reported as `job.failed`.

### 5.3 `fs.write`

| Argument | Type | Meaning |
|---|---|---|
| `path` | string | Destination. |

- The job's input is the file content.
- No output.
- `result`: `{"path":"C:\\...\\a.bin","size":131072}` — the absolute target path.
- Errors: `request.invalid`, `job.failed`.

The write is a whole-file replacement:

1. A temp file `<target-dir>/.eport-<random>.part` is created with `CreateNew`.
2. Input bytes are written to it as they arrive.
3. On `last`, the stream is flushed and closed, then `File.Move(temp, target, overwrite: true)` commits.

The temp file lives in the directory containing the target path. The commit is a rename. If the target is a symbolic link, the link itself is replaced; the link target is not written. On error or cancellation the temp file is deleted.

### 5.4 `fs.list`

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | required | Directory. |
| `recursive` | boolean | `false` | Recurse into subdirectories. |

- Output stream `entries`: JSON Lines, one object per line, each Binary message contains whole lines.
- Line shape: `{"name":"a.txt","path":"C:\\...\\a.txt","type":"file","size":12,"mtimeMs":1690000000000}`. `type` is `file`, `dir`, `link`, or `other`; `size` is omitted for `link`.
- Symbolic link entries are reported as `link` and are not followed, even with `recursive`. Entry order is unspecified.
- `result`: `{"count":42}`.
- Errors: `request.invalid`, `job.failed`.

### 5.5 `fs.stat`

| Argument | Type | Meaning |
|---|---|---|
| `path` | string | Path to inspect. |

- No streams.
- `result`: `{"type":"file","size":12,"mtimeMs":1690000000000}`; `type` is `file`, `dir`, or `other`. Symbolic links are followed.
- Errors: `request.invalid`, `job.failed`.

### 5.6 `fs.delete`

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `path` | string | required | File, link, or directory. |
| `recursive` | boolean | `false` | Delete a non-empty directory and its contents. |

- No streams.
- `result`: `{}`.
- Errors: `request.invalid`, `job.failed`.

A symbolic link is deleted itself, not its target.

### 5.7 `http.request`

| Argument | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | required | Absolute `http` or `https` URL. |
| `method` | string | `GET` | Request method. |
| `headers` | object | `{}` | Values are strings or arrays of strings. |
| `timeoutMs` | number | `60000` | Operation limit; starts after the input terminator; `0` means none. |

- The job's input is the request body. An empty input sends no body for `GET` and `HEAD`; other methods send a zero-length body.
- Output stream `body` (the response body).
- `result`: `{"status":200,"headers":{"content-type":"...","set-cookie":["..."]},"size":812,"durationMs":87}`.
- Errors: `request.invalid` (URL or method), `job.failed`, `job.timeout`, `job.cancelled`.

The limit starts after the input terminator and covers the entire operation, including all redirect hops.

Fixed client configuration:

- Cookies: a per-connection container. Matching cookies are added to every request; `Set-Cookie` is stored. Nothing is persisted.
- Redirects are followed automatically, at most 50 hops. The final response is returned; intermediate responses are discarded. A 3xx that is not followed is a normal result. A redirect that changes the method to `GET` drops the request body and the headers that describe it.
- HTTPS to HTTP redirects and redirects to unsupported schemes are not followed. `Authorization` and `ProxyAuthorization` are cleared on every redirect.
- Automatic decompression is on. The system proxy is used. Outgoing HTTPS accepts any certificate. There is no connection-level timeout beyond `timeoutMs`.
- Response headers use lowercase names; repeated headers are arrays.
- The final response body is staged to disk before it is sent. The file is read in chunks while it is sent. On a transport error the terminal message follows without a body stream.

### 5.8 `http.cookies.get`

- No arguments.
- No streams.
- `result`: `{"cookies":[{"name":"a","value":"1","domain":"example.com","path":"/","secure":false,"httpOnly":true,"expiresMs":1690000000000}]}`. `domain` and `expiresMs` are omitted when absent; `secure` and `httpOnly` default to `false`.

### 5.9 `http.cookies.set`

- Arguments: `{"cookies":[...]}` with records shaped as in §5.8.
- Replaces the entire container. `{"cookies":[]}` clears it.
- No streams. `result`: `{}`.

### 5.10 Card operations

Card operations are stateless and share one agent-wide slot. A card request that arrives while another card job runs waits for the slot; a `cancel` received while waiting ends it immediately. No card operation takes a `timeoutMs`.

`card.verify` and `card.sign` require string `device`, `deviceId`, and `pin`. The device name and device ID are 1–1024 UTF-8 bytes; the PIN is exactly 8 UTF-8 bytes. A request that fails validation is `request.invalid` before the job starts.

### 5.11 `card.list`

No parameters.

- No input, no output streams.
- `result`:

```json
{"devices":[{"name":"[PCSC] ...","deviceId":"...","certificateId":"..."}]}
```

All three fields are always present. A card whose name, certificate ID, or device ID is missing or empty is not listed. No compatible card yields `{"devices":[]}`.

The pair `name` and `deviceId` selects one device. `name` reaches the reader or token; `deviceId` identifies the device expected on it.

- Errors: `card.failed`, `job.cancelled`, `agent.internal`.

### 5.12 `card.verify`

| Argument | Type | Meaning |
|---|---|---|
| `device` | string | A name from `card.list`. |
| `deviceId` | string | The `deviceId` listed for that device. |
| `pin` | string | User PIN, exactly 8 bytes as UTF-8. |

- No input, no output streams.
- `result`: `{}`.
- Errors: `request.invalid`, `card.notFound`, `card.mismatch`, `card.pinRejected`, `card.pinRequired`, `card.failed`, `job.cancelled`, `agent.internal`.

The agent opens `device`, reads the card identity, and compares the device ID before it sends the PIN. A card that fails the comparison ends the request with `card.mismatch`; the PIN attempt is not consumed.

A successful verification does not create a reusable PIN session. A later `card.sign` submits the PIN again and verifies it in its own request. The calling application decides how long to keep the PIN.

### 5.13 `card.sign`

| Argument | Type | Meaning |
|---|---|---|
| `device` | string | A name from `card.list`. |
| `deviceId` | string | The `deviceId` listed for that device. |
| `pin` | string | User PIN, exactly 8 bytes as UTF-8. |

- The job's input is the message to sign. It is staged in the temp directory and streamed through the card engine. An empty input signs the empty message. There is no size limit beyond disk.
- No output streams.
- `result`:

```json
{"algorithm":"sm2","signature":"<base64>"}
```

`algorithm` is `sm2` or `rsa-sha1`. `signature` is standard base64; it decodes to 64 bytes for SM2 and 128 bytes for RSA-SHA1.

After the input terminator, the agent checks the identity exactly as `card.verify` does, verifies the PIN, and streams the staged message into the signer. It signs only when the card on `device` matches `deviceId` and the PIN is accepted.

- Errors: `request.invalid`, `card.notFound`, `card.mismatch`, `card.pinRejected`, `card.pinRequired`, `card.failed`, `job.failed`, `job.cancelled`, `agent.internal`.

## 6. Errors

### 6.1 Codes

| Code | Meaning |
|---|---|
| `request.invalid` | A well-formed request is invalid: bad `params` or an unknown `op`. |
| `job.cancelled` | The client cancelled the job. |
| `job.timeout` | `timeoutMs` elapsed. |
| `job.failed` | The operation failed: a filesystem error, a missing path, denied access, a process that could not start, an HTTP transport failure, or a disk or stream failure. |
| `agent.internal` | An unexpected failure inside the agent. |
| `card.notFound` | The named card is absent or does not answer. |
| `card.mismatch` | The card on the named device is not the requested device. |
| `card.pinRejected` | The card rejected the PIN. |
| `card.pinRequired` | The card requires a PIN session the request does not have. |
| `card.failed` | The card or its transport failed. |

### 6.2 Scope

Every `error` ends the request it answers; the connection stays usable. A malformed message, an invalid state transition, or a pairing violation closes the connection with code 1002. An oversized Text message closes it with code 1009.

## 7. Limits

| Limit | Value |
|---|---|
| Text message | 1 MiB |
| Jobs per connection | 1 |
| Card jobs per agent | 1 |
| Card device name / device ID | 1–1024 UTF-8 bytes |
| Card certificate ID | 1–128 hexadecimal characters |
| Card PIN | exactly 8 UTF-8 bytes |
| HID command timeout | 8 s |
| Automatic redirects | 50 |
| Default `http.request` operation timeout | 60 s |

## 8. Cleanup

- The job temp directory is `<user temp>/eport-runtime/<jobId>/` (per-user; on Unix mode 0700). It holds stdin, captured stdout and stderr, HTTP request and final response bodies, and the signing message. It is deleted when the job ends.
- On connection close, the current job is aborted and its temp directory deleted.
- After binding the listener and before serving, the agent deletes the whole `<user temp>/eport-runtime` root.
- `fs.write` temp files live next to the target; a crash may leave one behind.

## 9. Frozen contract

The following strings and shapes are frozen for version 1:

- Subprotocol `eport-runtime.v1`; endpoint `127.0.0.1:26099`; path `/`.
- Message kinds Text and Binary, and the pairing rule.
- `type` values `request`, `chunk`, `cancel`, `result`, `error`.
- Field names `type`, `op`, `params`, `stream`, `last`, `result`, `code`, `message`.
- Operation names `exec.run`, `fs.list`, `fs.read`, `fs.write`, `fs.delete`, `fs.stat`, `http.request`, `http.cookies.get`, `http.cookies.set`, `card.list`, `card.verify`, `card.sign`.
- Output stream names `stdout`, `stderr`, `content`, `body`, `entries`.
- The ten error codes in §6.1.

## 10. Security

Any process that reaches `127.0.0.1:26099` — including any web page the user visits — has the user's full capabilities, including verifying a PIN and signing with an inserted card. The listener binds loopback only. Outgoing HTTPS accepts any certificate.

The private key never leaves the card. The agent does not store the PIN, does not log request parameters, and zeroes the UTF-8 PIN buffer after each verification. Card jobs do not share an open device. The calling application decides how long to retain a PIN for later requests.
