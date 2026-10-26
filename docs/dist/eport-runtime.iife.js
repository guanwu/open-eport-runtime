"use strict";
var EportRuntime = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/EportRuntimeSdk/index.ts
  var index_exports = {};
  __export(index_exports, {
    AgentClient: () => AgentClient,
    AgentError: () => AgentError,
    ConnectionClosedError: () => ConnectionClosedError,
    ENDPOINT: () => ENDPOINT,
    ProtocolError: () => ProtocolError,
    SUBPROTOCOL: () => SUBPROTOCOL,
    connect: () => connect
  });

  // src/EportRuntimeSdk/errors.ts
  var AgentError = class extends Error {
    constructor(code, message) {
      super(message);
      this.name = "AgentError";
      this.code = code;
    }
  };
  var ConnectionClosedError = class extends Error {
    constructor(message = "the agent connection is closed") {
      super(message);
      this.name = "ConnectionClosedError";
    }
  };
  var ProtocolError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "ProtocolError";
    }
  };

  // src/EportRuntimeSdk/protocol.ts
  var ENDPOINT = "ws://127.0.0.1:26099/";
  var SUBPROTOCOL = "eport-runtime.v1";

  // src/EportRuntimeSdk/connection.ts
  var MaxSendBytes = 1024 * 1024;
  var MaxBufferedBytes = 8 * 1024 * 1024;
  var DefaultConnectTimeoutMs = 1e3;
  var OperationState = class {
    constructor(handlers, allowed) {
      this.opened = /* @__PURE__ */ new Set();
      this.completed = /* @__PURE__ */ new Set();
      this.decoder = new TextDecoder();
      this.entryRemainder = "";
      this.currentStream = null;
      this.settled = false;
      this.isFinished = false;
      this.handlers = handlers;
      this.allowed = allowed;
      this.promise = new Promise((resolve, reject) => {
        this.resolveOperation = resolve;
        this.rejectOperation = reject;
      });
      this.finished = new Promise((resolve) => {
        this.finishOperation = resolve;
      });
    }
    resolve(value) {
      if (this.settled) {
        return;
      }
      this.settled = true;
      this.resolveOperation(value);
    }
    reject(error) {
      if (this.settled) {
        return;
      }
      this.settled = true;
      this.rejectOperation(error);
    }
    finish() {
      if (this.isFinished) {
        return;
      }
      this.isFinished = true;
      this.finishOperation();
    }
    streamsComplete() {
      for (const stream of this.opened) {
        if (!this.completed.has(stream)) {
          return false;
        }
      }
      return true;
    }
    async dispatch(stream, bytes, last) {
      if (stream === "entries") {
        const text = this.decoder.decode(bytes, { stream: !last });
        this.entryRemainder += text;
        const lines = this.entryRemainder.split("\n");
        this.entryRemainder = lines.pop() ?? "";
        for (const line of lines) {
          await this.dispatchEntry(line);
        }
        if (last && this.entryRemainder.length > 0) {
          const remainder = this.entryRemainder;
          this.entryRemainder = "";
          await this.dispatchEntry(remainder);
        }
        return;
      }
      const handler = stream === "stdout" ? this.handlers.onStdout : stream === "stderr" ? this.handlers.onStderr : this.handlers.onChunk;
      await handler?.(bytes);
    }
    async dispatchEntry(line) {
      const text = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (text.length === 0) {
        return;
      }
      let entry;
      try {
        entry = JSON.parse(text);
      } catch {
        throw new ProtocolError("invalid entries JSON");
      }
      await this.handlers.onEntry?.(entry);
    }
  };
  var Connection = class _Connection {
    constructor(ws) {
      this.current = null;
      this.pendingChunk = null;
      this.receiveTail = Promise.resolve();
      this.tail = Promise.resolve();
      this.socketClosed = false;
      this.closed = false;
      this.ws = ws;
      ws.onmessage = (event) => this.enqueueMessage(event.data);
      ws.onclose = () => this.enqueueClose();
      ws.onerror = () => void 0;
    }
    static connect(url = ENDPOINT, timeoutMs = DefaultConnectTimeoutMs) {
      return new Promise((resolve, reject) => {
        let ws;
        try {
          ws = new WebSocket(url, SUBPROTOCOL);
        } catch (error) {
          reject(new ConnectionClosedError(describeError(error)));
          return;
        }
        ws.binaryType = "arraybuffer";
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          try {
            ws.close();
          } catch {
          }
          reject(new ConnectionClosedError("timed out while connecting to the agent"));
        }, timeoutMs);
        ws.onopen = () => {
          if (settled) {
            return;
          }
          if (ws.protocol !== SUBPROTOCOL) {
            settled = true;
            clearTimeout(timer);
            try {
              ws.close();
            } catch {
            }
            reject(new ProtocolError("the agent did not select the eport-runtime.v1 subprotocol"));
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(new _Connection(ws));
        };
        ws.onerror = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new ConnectionClosedError("could not connect to the agent"));
          }
        };
        ws.onclose = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new ConnectionClosedError("could not connect to the agent"));
          }
        };
      });
    }
    // The socket carries one job at a time. Each call queues behind the previous
    // call's terminal message, matching the agent's one-job-at-a-time rule.
    run(op, params, handlers, input) {
      const previous = this.tail;
      let release;
      this.tail = new Promise((resolve) => {
        release = resolve;
      });
      return (async () => {
        await previous;
        if (this.closed || this.socketClosed) {
          release();
          throw new ConnectionClosedError();
        }
        const state = new OperationState(handlers, allowedStreams(op));
        let started = false;
        let startError;
        try {
          this.current = state;
          this.send({ type: "request", op, params });
          started = true;
          void this.upload(state, input).catch((error) => {
            this.uploadFailed(state, error);
          });
        } catch (error) {
          startError = error;
          this.current = null;
          state.finish();
        }
        state.finished.then(release);
        if (!started) {
          throw asError(startError);
        }
        return state.promise;
      })();
    }
    close() {
      if (this.closed) {
        return;
      }
      this.closed = true;
      const state = this.current;
      this.current = null;
      state?.reject(new ConnectionClosedError("connection closed"));
      state?.finish();
      try {
        this.ws.close(1e3, "client closed");
      } catch {
      }
    }
    enqueueMessage(data) {
      if (this.closed) {
        return;
      }
      this.receiveTail = this.receiveTail.then(() => this.handleMessage(data)).catch((error) => this.receiveFailure(error));
    }
    enqueueClose() {
      if (this.socketClosed) {
        return;
      }
      this.socketClosed = true;
      this.receiveTail = this.receiveTail.then(() => this.handleClose()).catch(() => this.handleClose());
    }
    async handleMessage(data) {
      if (this.closed) {
        return;
      }
      if (typeof data === "string") {
        this.handleText(data);
        return;
      }
      const bytes = await toBytesAsync(data);
      if (this.closed) {
        return;
      }
      await this.handleBinary(bytes);
    }
    handleText(text) {
      if (this.pendingChunk !== null) {
        throw new ProtocolError("a text message arrived between a chunk header and its binary");
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ProtocolError("the agent sent invalid JSON");
      }
      if (!isRecord(parsed) || typeof parsed.type !== "string") {
        throw new ProtocolError("the agent sent an invalid message");
      }
      switch (parsed.type) {
        case "chunk":
          if (typeof parsed.stream !== "string" || typeof parsed.last !== "boolean") {
            throw new ProtocolError("the agent sent an invalid chunk header");
          }
          this.pendingChunk = {
            type: "chunk",
            stream: parsed.stream,
            last: parsed.last
          };
          return;
        case "result":
          this.handleTerminal({ type: "result", result: parsed.result });
          return;
        case "error":
          if (typeof parsed.code !== "string" || typeof parsed.message !== "string") {
            throw new ProtocolError("the agent sent an invalid error");
          }
          this.handleTerminal({ type: "error", code: parsed.code, message: parsed.message });
          return;
        default:
          throw new ProtocolError("the agent sent an unknown message type");
      }
    }
    // A Binary frame must close the pending chunk header. Streams cannot
    // interleave, restart after last, or appear unless the operation allows them.
    async handleBinary(bytes) {
      const chunk = this.pendingChunk;
      if (chunk === null) {
        throw new ProtocolError("a binary message arrived without a chunk header");
      }
      this.pendingChunk = null;
      const state = this.current;
      if (state === null || state.settled) {
        return;
      }
      if (!state.allowed.has(chunk.stream)) {
        throw new ProtocolError(`unexpected output stream: ${chunk.stream}`);
      }
      if (state.completed.has(chunk.stream)) {
        throw new ProtocolError(`output stream already ended: ${chunk.stream}`);
      }
      if (state.currentStream !== null && state.currentStream !== chunk.stream) {
        throw new ProtocolError("output streams were interleaved");
      }
      state.currentStream = chunk.stream;
      state.opened.add(chunk.stream);
      if (chunk.last) {
        state.completed.add(chunk.stream);
        state.currentStream = null;
      }
      await state.dispatch(chunk.stream, bytes, chunk.last);
    }
    // A result is valid only after every stream this operation opened ended with
    // last; an error carries the agent's protocol code.
    handleTerminal(message) {
      const state = this.current;
      if (state === null) {
        throw new ProtocolError("a terminal message arrived without a request");
      }
      this.current = null;
      if (!state.settled) {
        if (message.type === "result" && !state.streamsComplete()) {
          state.reject(new ProtocolError("an output stream ended without last"));
        } else if (message.type === "error") {
          state.reject(new AgentError(message.code, message.message));
        } else {
          state.resolve(message.result);
        }
      }
      state.finish();
    }
    receiveFailure(error) {
      if (this.closed) {
        return;
      }
      if (error instanceof ProtocolError) {
        this.protocolFailure(error);
        return;
      }
      const state = this.current;
      if (state === null) {
        this.protocolFailure(asError(error));
        return;
      }
      if (state.settled) {
        return;
      }
      state.reject(asError(error));
      this.cancel();
    }
    uploadFailed(state, error) {
      if (state.settled || this.closed) {
        return;
      }
      state.reject(asError(error));
      this.cancel();
    }
    // A framing violation leaves the socket unusable: close with 1002 and reject
    // the active operation.
    protocolFailure(error) {
      this.socketClosed = true;
      this.closed = true;
      try {
        this.ws.close(1002, "protocol error");
      } catch {
      }
      const state = this.current;
      this.current = null;
      state?.reject(error);
      state?.finish();
    }
    handleClose() {
      this.closed = true;
      const state = this.current;
      this.current = null;
      if (state !== null) {
        state.reject(new ConnectionClosedError());
        state.finish();
      }
    }
    send(message) {
      if (this.socketClosed || this.closed) {
        throw new ConnectionClosedError();
      }
      this.ws.send(JSON.stringify(message));
    }
    async sendChunk(last, bytes) {
      if (this.socketClosed || this.closed) {
        throw new ConnectionClosedError();
      }
      const header = { type: "chunk", last };
      this.ws.send(JSON.stringify(header));
      this.ws.send(bytes);
      await this.drain();
    }
    async drain() {
      while (this.ws.bufferedAmount > MaxBufferedBytes) {
        if (this.socketClosed || this.closed) {
          throw new ConnectionClosedError();
        }
        await delay(1);
      }
      if (this.socketClosed || this.closed) {
        throw new ConnectionClosedError();
      }
    }
    // Asks the agent to cancel the job in flight; the operation rejects with
    // job.cancelled when the agent confirms.
    cancel() {
      try {
        const message = { type: "cancel" };
        this.send(message);
      } catch {
      }
    }
    // Data chunks are never marked last, so bytes leave as soon as the source
    // produces them; an empty chunk marked last terminates the input.
    async upload(state, input) {
      const iterator = readInput(input);
      const total = inputSize(input);
      let sent = 0;
      try {
        while (!state.settled) {
          const next = await iterator.next();
          if (state.settled || next.done) {
            break;
          }
          for (const piece of splitBytes(next.value)) {
            await this.sendChunk(false, piece);
            sent += piece.byteLength;
            if (state.settled) {
              return;
            }
            reportProgress(state, sent, total);
          }
        }
        if (!state.settled) {
          await this.sendChunk(true, new Uint8Array(0));
        }
      } finally {
        try {
          await iterator.return(void 0);
        } catch {
        }
      }
    }
  };
  function allowedStreams(op) {
    switch (op) {
      case "exec.run":
        return /* @__PURE__ */ new Set(["stdout", "stderr"]);
      case "fs.read":
        return /* @__PURE__ */ new Set(["content"]);
      case "fs.list":
        return /* @__PURE__ */ new Set(["entries"]);
      case "http.request":
        return /* @__PURE__ */ new Set(["body"]);
      default:
        return /* @__PURE__ */ new Set();
    }
  }
  async function* readInput(input) {
    if (input === void 0) {
      return;
    }
    if (input instanceof Uint8Array) {
      yield input;
      return;
    }
    if (input instanceof ArrayBuffer) {
      yield new Uint8Array(input);
      return;
    }
    const stream = typeof Blob !== "undefined" && input instanceof Blob ? input.stream() : isReadableStream(input) ? input : null;
    if (stream === null) {
      throw new TypeError("unsupported input source");
    }
    const reader = stream.getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          return;
        }
        yield toBytes(next.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  function isReadableStream(value) {
    return typeof value === "object" && value !== null && typeof value.getReader === "function";
  }
  function splitBytes(bytes) {
    if (bytes.byteLength === 0 || bytes.byteLength <= MaxSendBytes) {
      return [bytes];
    }
    const pieces = [];
    for (let offset = 0; offset < bytes.byteLength; offset += MaxSendBytes) {
      pieces.push(bytes.subarray(offset, Math.min(offset + MaxSendBytes, bytes.byteLength)));
    }
    return pieces;
  }
  function inputSize(input) {
    if (input === void 0) {
      return null;
    }
    if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
      return input.byteLength;
    }
    if (typeof Blob !== "undefined" && input instanceof Blob) {
      return input.size;
    }
    return null;
  }
  function reportProgress(state, sent, total) {
    try {
      state.handlers.onProgress?.(sent, total);
    } catch {
    }
  }
  async function toBytesAsync(data) {
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      return new Uint8Array(await data.arrayBuffer());
    }
    throw new ProtocolError("the agent sent an unexpected binary payload");
  }
  function toBytes(data) {
    if (data instanceof Uint8Array) {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    throw new TypeError("the input stream produced a non-binary chunk");
  }
  function isRecord(value) {
    return typeof value === "object" && value !== null;
  }
  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  function asError(error) {
    if (error instanceof Error) {
      return error;
    }
    return new Error(String(error));
  }
  function describeError(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // src/EportRuntimeSdk/card.ts
  var CardApi = class {
    constructor(invoke) {
      this.invoke = invoke;
    }
    list() {
      return this.invoke("card.list", {}, {});
    }
    verify(params) {
      return this.invoke("card.verify", params, {});
    }
    sign(params, io) {
      return this.invoke("card.sign", params, { onProgress: io.onProgress }, io.input);
    }
  };

  // src/EportRuntimeSdk/exec.ts
  var ExecApi = class {
    constructor(invoke) {
      this.invoke = invoke;
    }
    run(params, io = {}) {
      return this.invoke(
        "exec.run",
        params,
        { onStdout: io.onStdout, onStderr: io.onStderr, onProgress: io.onProgress },
        io.input
      );
    }
  };

  // src/EportRuntimeSdk/files.ts
  var FilesApi = class {
    constructor(invoke) {
      this.invoke = invoke;
    }
    read(params, io = {}) {
      return this.invoke("fs.read", params, { onChunk: io.onChunk });
    }
    write(params, io = {}) {
      return this.invoke("fs.write", params, { onProgress: io.onProgress }, io.input);
    }
    list(params, io = {}) {
      return this.invoke("fs.list", params, { onEntry: io.onEntry });
    }
    stat(params) {
      return this.invoke("fs.stat", params, {});
    }
    delete(params) {
      return this.invoke("fs.delete", params, {});
    }
  };

  // src/EportRuntimeSdk/http.ts
  var HttpCookiesApi = class {
    constructor(invoke) {
      this.invoke = invoke;
    }
    get() {
      return this.invoke("http.cookies.get", {}, {});
    }
    set(params) {
      return this.invoke("http.cookies.set", params, {});
    }
  };
  var HttpApi = class {
    constructor(invoke) {
      this.invoke = invoke;
      this.cookies = new HttpCookiesApi(invoke);
    }
    request(params, io = {}) {
      return this.invoke(
        "http.request",
        params,
        { onChunk: io.onChunk, onProgress: io.onProgress },
        io.input
      );
    }
  };

  // src/EportRuntimeSdk/wake.ts
  var WakeUrl = "eport-runtime://wake";
  var FrameLifetimeMs = 2e3;
  function wake() {
    if (typeof document === "undefined") {
      return false;
    }
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.src = WakeUrl;
    (document.body ?? document.documentElement).append(frame);
    window.setTimeout(() => frame.remove(), FrameLifetimeMs);
    return true;
  }

  // src/EportRuntimeSdk/client.ts
  var WakeAttemptTimeoutMs = 1e3;
  var WakeRetryDelayMs = 250;
  var WakeDeadlineMs = 5e3;
  var AgentClient = class _AgentClient {
    constructor(connection) {
      this.connection = connection;
      const invoke = (op, params, handlers, input) => this.connection.run(op, params, handlers, input);
      this.exec = new ExecApi(invoke);
      this.fs = new FilesApi(invoke);
      this.http = new HttpApi(invoke);
      this.card = new CardApi(invoke);
    }
    static async connect(options = {}) {
      const connection = await connectWithWake(options);
      return new _AgentClient(connection);
    }
    // Cancels the operation in flight; its promise rejects with job.cancelled.
    cancel() {
      this.connection.cancel();
    }
    close() {
      this.connection.close();
    }
  };
  function connect(options = {}) {
    return AgentClient.connect(options);
  }
  async function connectWithWake(options) {
    const url = options.url ?? ENDPOINT;
    const timeoutMs = options.timeoutMs ?? DefaultConnectTimeoutMs;
    const wakes = url === ENDPOINT && options.wake !== false;
    const attemptTimeoutMs = wakes ? Math.min(timeoutMs, WakeAttemptTimeoutMs) : timeoutMs;
    try {
      return await Connection.connect(url, attemptTimeoutMs);
    } catch (error) {
      if (!wakes || !(error instanceof ConnectionClosedError)) {
        throw error;
      }
    }
    if (!wake()) {
      throw new ConnectionClosedError(
        "the agent is not running and cannot be started outside a browser"
      );
    }
    const deadline = Date.now() + WakeDeadlineMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        return await Connection.connect(url, attemptTimeoutMs);
      } catch (error) {
        if (!(error instanceof ConnectionClosedError)) {
          throw error;
        }
        lastError = error;
      }
      await delay2(WakeRetryDelayMs);
    }
    throw lastError ?? new ConnectionClosedError("timed out while connecting to the agent");
  }
  function delay2(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  return __toCommonJS(index_exports);
})();
//# sourceMappingURL=eport-runtime.iife.js.map
