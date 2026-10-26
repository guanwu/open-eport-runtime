# Open ePort Runtime — Design

Version 1 (`eport-runtime.v1`). The wire is defined in `PROTOCOL.md`.

## 1. What this is

A local capability agent for Windows and Linux. One WebSocket to `127.0.0.1:26099` gives a page or a local process four capability groups: process execution, local files, HTTP with a per-connection cookie jar, and ePort smart cards.

The backend is C# / .NET 10 / Native AOT, published as one self-contained executable, and a WinExe on Windows; it registers `eport-runtime://` at startup. The SDK is TypeScript built by esbuild as IIFE and ESM bundles with declarations. The card engine is the `eportskf` C static library package linked into the backend and the only component that talks to card hardware.

## 2. Model

One connection carries one job at a time and owns one HTTP client, one cookie container, and the current job's temp directory. A job receives input into a file, executes, sends file-backed output, and ends with one terminal message.

Card jobs are stateless: each request opens the device it names and closes it before the terminal message. `card.verify` and `card.sign` confirm the device identity and check the PIN; `card.sign` then signs. No PIN state survives a request. The agent runs one card job at a time across all connections.

## 3. Card engine

The engine keeps no key material and no randomness. Its state is an open device plus any streaming signature the device owns. The facade owns devices and results; applets speak the SM2 and RSA card protocols over PC/SC and USB HID transports; helpers parse DER and GBK text and compute SM2/SM3/SM4/SHA1. Every facade call returns a result code and the engine describes it with `eportskf_result_description`.

Signing is streaming: `eportskf_sign_start` initializes the message hash on an open device; `eportskf_sign_update` hashes each chunk; `eportskf_sign_finish` signs the digest and returns the signature; `eportskf_sign_abort` ends the active signature without signing. `eportskf_sign` is the one-shot form.

A device name is `[factory] descriptor`, with factory tag `PCSC` or `HID`.

Enumeration opens each candidate, probes the applet pinned to the link, and reads the certificate. Cards that cannot be opened, probed, or identified are skipped. The certificate serial number is the certificate ID; the device ID is a certificate extension.

| Family | Link | Signing |
|---|---|---|
| ePort smart card | PC/SC | SM2 applet; SM3 over `ZA ‖ message`; 64-byte `r ‖ s`. |
| ePort USB token | USB HID | RSA applet; SHA1 reversed; 128-byte PKCS#1 v1.5. |

Both families take an 8-byte PIN, which belongs to the device, not to a certificate. The SM2 PIN block is SM4-enciphered under `SHA1` of the padded PIN with a fresh challenge; the RSA token unlocks with a fixed transport PIN and puts the 8-byte PIN in its verify command. Signing without a verified PIN reports `EPORTSKF_VERIFICATION_REQUIRED`; a rejected PIN reports `EPORTSKF_PIN_REJECTED`. Signatures are 64 or 128 bytes in card order.

## 4. Backend

### 4.1 Layout

```
src/EportRuntime/
  Program.cs              Startup, identity, logging, scheme registration
  Protocol.cs             Operations, messages, wire format, errors, limits
  AgentServer.cs          Listener, handshake, session ownership
  Session.cs              WebSocket receive loop and job dispatch
  Job.cs                  Request validation, staging, execution, cleanup
  Exec.cs                 Process execution
  Files.cs                Path resolution and file operations
  Http.cs                 HTTP requests and cookie jar
  Card.cs                 eportskf bindings and card operations
src/EportRuntimeSdk/       SDK (TypeScript)
tests/smoke.mjs           End-to-end test
tests/card.mjs            Manual card test
docs/index.html           Test console source
```

The GitHub Pages site is served from `docs/`, which contains `index.html`, the SDK bundles in `docs/dist`, and copies of `README.md`, `DESIGN.md`, and `PROTOCOL.md`. `npm run build` refreshes the bundles and document copies; both are committed.

### 4.2 Card capability

`CardService` owns one agent-wide card slot. `ListAsync` discards every device whose name, certificate ID, or device ID is missing or empty.

`VerifyAsync` opens `device`, reads the identity, compares the device ID byte for byte, then calls `eportskf_verify_pin` and closes. A mismatch reports `card.mismatch` before the PIN is sent, so it never consumes an attempt.

`SignAsync` follows the same open and identity check, verifies the PIN, starts a signature, streams the staged message through `eportskf_sign_update` in bounded chunks, calls `eportskf_sign_finish`, and closes. An unfinished signature is aborted with `eportskf_sign_abort`. The identity is released immediately and is not returned.

Native calls are blittable: `eportskf_result`, `eportskf_device_list`, `eportskf_device_info`, `eportskf_identity`, and `eportskf_signature`. Strings are copied while the native owner is alive; no pointer escapes `CardService`. The PIN is a NUL-terminated UTF-8 buffer, zeroed after verification and never logged.

### 4.3 Job integration

`card.list` and `card.verify` have no streams; `card.sign` stages `message.bin` as its input, streams it after the terminator, and returns the signature. The file size is limited only by disk.

Engine results map as follows: `EPORTSKF_DEVICE_UNAVAILABLE` → `card.notFound`, `EPORTSKF_PIN_REJECTED` → `card.pinRejected`, `EPORTSKF_VERIFICATION_REQUIRED` → `card.pinRequired`, `EPORTSKF_UNUSABLE_ARGUMENT` → `request.invalid`, `EPORTSKF_FAILURE` → `card.failed`.

Cancellation during a native call is reported after it returns; cancellation while waiting for the card slot ends the job immediately.

## 5. SDK

`client.card` exposes `list()`, `verify({device, deviceId, pin})`, and `sign({device, deviceId, pin}, {input})`. `CardDevice` carries `name`, `deviceId`, and `certificateId`; a signature carries `algorithm` (`sm2` or `rsa-sha1`) and a base64 `signature`. The SDK reads while it sends, stops the upload on a terminal message, and serialises requests on the connection.

## 6. Resource ownership

| Resource | Creator | Destroyer |
|---|---|---|
| WebSocket | upgrade | close |
| HTTP client + cookie container | session | session close |
| Current job | `request` | terminal message |
| Child process tree | `exec.run` | exit, cancel, timeout, session close |
| Job temp directory | `request` | terminal, session close, startup sweep |
| `fs.write` temp file | `fs.write` | rename, error, session close |
| Card job slot | `CardService` | agent shutdown |
| Card handle | `eportskf_open` | `eportskf_close` on every path |
| Signature | `eportskf_sign_start` | `eportskf_sign_finish` / `eportskf_sign_abort` |
| Device list / identity | `eportskf_enumerate` / `eportskf_read_identity` | matching free call |
| PIN buffer | `CardService` | zeroed after `eportskf_verify_pin` |

## 7. Build and verification

| Platform | Engine library | Link inputs |
|---|---|---|
| Windows x64, arm64 | `eportskf_static.lib` | `winscard.lib`, `hid.lib`, `setupapi.lib` |
| Linux x64, arm64 | `libeportskf_static.a` | `-ldl` |

The engine is the `eportskf` native package from GitHub Packages. The project references it with `GeneratePathProperty` and links `<RID>/lib/eportskf_static.lib` on Windows or `<RID>/lib/libeportskf_static.a` on Linux. The backend binds `eportskf` with `DirectPInvoke` and links the library with `NativeLibrary`, so the published executable contains the engine. PC/SC needs the Windows Smart Card service, Linux `libpcsclite`, and access to `/dev/hidraw*`.

Builds run in GitHub Actions on every push and pull request. The workflow restores the package, typechecks the SDK, publishes `win-x64`, `win-arm64`, `linux-x64`, and `linux-arm64`, stages `docs/`, `README.md`, and `LICENSE`, runs `tests/smoke.mjs` on the executable targets, and uploads one archive per platform. A published release receives the same archives as assets. GitHub Pages serves the console site from `docs/` on the default branch.

Verification:

1. The build workflow builds every target, runs the SDK typecheck, and runs the smoke test against the committed bundles. The smoke test covers the subprotocol, files, exec, HTTP, SDK serialisation, parameter validation, and `card.notFound` without attached hardware.
2. With a card, `tests/card.mjs` checks that `card.list` includes the device, verify succeeds with the correct PIN, an empty message and a 20 MiB message sign to the expected lengths, and a wrong device ID reports `card.mismatch` before any PIN is sent.
3. Verify once, record the PIN by device, and sign later with it.
