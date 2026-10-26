# Open ePort Runtime

A local capability agent for Windows and Linux. One WebSocket to `ws://127.0.0.1:26099/` with the `eport-runtime.v1` subprotocol gives a page or a local process four capability groups: run executables, work with local files, make HTTP requests with a per-connection cookie jar, and use ePort smart cards.

## Run

Download the bundle for your platform from [Releases](https://github.com/guanwu/open-eport-runtime/releases):

- `eport-runtime-windows-x64.zip` — Windows x64
- `eport-runtime-windows-arm64.zip` — Windows arm64
- `eport-runtime-linux-x64.tar.gz` — Linux x64
- `eport-runtime-linux-arm64.tar.gz` — Linux arm64

Unpack it and start the agent:

```sh
eport-runtime.exe        # Windows
./eport-runtime          # Linux
```

The agent listens on loopback only. On Windows it runs without a console window and registers `eport-runtime://` for the current user. Open `docs/index.html` from the bundle in a browser to use the test console.

## Connect from a page

```html
<script src="docs/dist/eport-runtime.iife.min.js"></script>
<script>
  const client = await EportRuntime.connect();
  const stat = await client.fs.stat({ path: "." });
  client.close();
</script>
```

`connect()` starts the agent through `eport-runtime://wake` when it is not running; allow the browser prompt. Pass `{ wake: false }` when the agent is already running or when connecting to a custom `url`.

## Documentation

- [`PROTOCOL.md`](PROTOCOL.md) — wire protocol, operations, errors, and limits
- [`DESIGN.md`](DESIGN.md) — components, card engine, and resource ownership
- `docs/index.html` — browser test console

## Development

`docs/` is complete in the repository: the SDK bundles in `docs/dist` and copies of `README.md`, `DESIGN.md`, and `PROTOCOL.md` are generated locally with `npm run build` and committed. Run `npm ci` and `npm run build` after changing `src/EportRuntimeSdk/` or one of those documents, then commit the updated files under `docs/`. GitHub Actions typechecks the SDK and builds, tests, and packages the agent on every push and pull request; no local C++ toolchain is needed. GitHub Pages serves `docs/` from the default branch.

## Security

Any process or page that can reach `127.0.0.1:26099` has the user's capabilities on the machine. Outgoing HTTPS accepts any certificate. The private key never leaves the card, and the agent does not store the PIN.

## Licence

Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>.

This project is licensed under `AGPL-3.0-only`. See `LICENSE`.
