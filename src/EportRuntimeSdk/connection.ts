// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { AgentError, ConnectionClosedError, ProtocolError } from "./errors";
import { ENDPOINT, SUBPROTOCOL } from "./protocol";
import type {
  ClientCancel,
  ClientChunk,
  ClientText,
  FsEntry,
  ServerChunk,
  ServerError,
  ServerResult,
} from "./protocol";

export type ChunkHandler = (chunk: Uint8Array) => void | Promise<void>;
export type EntryHandler = (entry: FsEntry) => void | Promise<void>;
export type ProgressHandler = (sent: number, total: number | null) => void;

export interface StreamHandlers {
  onChunk?: ChunkHandler;
  onEntry?: EntryHandler;
  onProgress?: ProgressHandler;
  onStdout?: ChunkHandler;
  onStderr?: ChunkHandler;
}

export type InputSource =
  | Uint8Array
  | ArrayBuffer
  | Blob
  | ReadableStream<Uint8Array>;

export type Invoke = <T>(
  op: string,
  params: object,
  handlers: StreamHandlers,
  input?: InputSource,
) => Promise<T>;

// The agent caps a Text message at 1 MiB. A Binary frame has no such cap and
// costs one header plus one send, so large inputs are split at this size.
const MaxSendBytes = 1024 * 1024;
// Backpressure threshold: a fast producer waits while the socket has more than
// this much queued, which bounds upload memory instead of buffering it all.
const MaxBufferedBytes = 8 * 1024 * 1024;
export const DefaultConnectTimeoutMs = 1000;

// Stream state for one operation. The agent emits entries as JSON Lines, so a
// streaming TextDecoder and a line remainder carry partial UTF-8 sequences and
// partial lines across chunk boundaries.
class OperationState {
  readonly handlers: StreamHandlers;
  readonly allowed: ReadonlySet<string>;
  readonly opened = new Set<string>();
  readonly completed = new Set<string>();
  readonly promise: Promise<unknown>;
  readonly finished: Promise<void>;
  readonly decoder = new TextDecoder();
  entryRemainder = "";
  currentStream: string | null = null;
  settled = false;

  private resolveOperation!: (value: unknown) => void;
  private rejectOperation!: (error: Error) => void;
  private finishOperation!: () => void;
  private isFinished = false;

  constructor(handlers: StreamHandlers, allowed: ReadonlySet<string>) {
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

  resolve(value: unknown): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.resolveOperation(value);
  }

  reject(error: Error): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.rejectOperation(error);
  }

  finish(): void {
    if (this.isFinished) {
      return;
    }

    this.isFinished = true;
    this.finishOperation();
  }

  streamsComplete(): boolean {
    for (const stream of this.opened) {
      if (!this.completed.has(stream)) {
        return false;
      }
    }

    return true;
  }

  async dispatch(stream: string, bytes: Uint8Array, last: boolean): Promise<void> {
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

    const handler =
      stream === "stdout" ? this.handlers.onStdout
      : stream === "stderr" ? this.handlers.onStderr
      : this.handlers.onChunk;

    await handler?.(bytes);
  }

  private async dispatchEntry(line: string): Promise<void> {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (text.length === 0) {
      return;
    }

    let entry: FsEntry;
    try {
      entry = JSON.parse(text) as FsEntry;
    } catch {
      throw new ProtocolError("invalid entries JSON");
    }

    await this.handlers.onEntry?.(entry);
  }
}

export class Connection {
  private readonly ws: WebSocket;
  private current: OperationState | null = null;
  private pendingChunk: ServerChunk | null = null;
  private receiveTail: Promise<void> = Promise.resolve();
  private tail: Promise<void> = Promise.resolve();
  private socketClosed = false;
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (event) => this.enqueueMessage(event.data);
    ws.onclose = () => this.enqueueClose();
    ws.onerror = () => undefined;
  }

  static connect(
    url = ENDPOINT,
    timeoutMs = DefaultConnectTimeoutMs,
  ): Promise<Connection> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
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
        resolve(new Connection(ws));
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
  run<T>(
    op: string,
    params: object,
    handlers: StreamHandlers,
    input?: InputSource,
  ): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
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
      let startError: unknown;

      try {
        this.current = state;
        this.send({ type: "request", op, params });
        started = true;
        void this.upload(state, input).catch((error: unknown) => {
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

      return state.promise as Promise<T>;
    })();
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    const state = this.current;
    this.current = null;
    state?.reject(new ConnectionClosedError("connection closed"));
    state?.finish();

    try {
      this.ws.close(1000, "client closed");
    } catch {
    }
  }

  private enqueueMessage(data: unknown): void {
    if (this.closed) {
      return;
    }

    this.receiveTail = this.receiveTail
      .then(() => this.handleMessage(data))
      .catch((error: unknown) => this.receiveFailure(error));
  }

  private enqueueClose(): void {
    if (this.socketClosed) {
      return;
    }

    this.socketClosed = true;
    this.receiveTail = this.receiveTail
      .then(() => this.handleClose())
      .catch(() => this.handleClose());
  }

  private async handleMessage(data: unknown): Promise<void> {
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

  private handleText(text: string): void {
    if (this.pendingChunk !== null) {
      throw new ProtocolError("a text message arrived between a chunk header and its binary");
    }

    let parsed: unknown;
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
          last: parsed.last,
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
  private async handleBinary(bytes: Uint8Array): Promise<void> {
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
  private handleTerminal(message: ServerResult | ServerError): void {
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

  private receiveFailure(error: unknown): void {
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

  private uploadFailed(state: OperationState, error: unknown): void {
    if (state.settled || this.closed) {
      return;
    }

    state.reject(asError(error));
    this.cancel();
  }

  // A framing violation leaves the socket unusable: close with 1002 and reject
  // the active operation.
  private protocolFailure(error: Error): void {
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

  private handleClose(): void {
    this.closed = true;

    const state = this.current;
    this.current = null;
    if (state !== null) {
      state.reject(new ConnectionClosedError());
      state.finish();
    }
  }

  private send(message: ClientText): void {
    if (this.socketClosed || this.closed) {
      throw new ConnectionClosedError();
    }

    this.ws.send(JSON.stringify(message));
  }

  private async sendChunk(last: boolean, bytes: Uint8Array): Promise<void> {
    if (this.socketClosed || this.closed) {
      throw new ConnectionClosedError();
    }

    const header: ClientChunk = { type: "chunk", last };
    this.ws.send(JSON.stringify(header));
    this.ws.send(bytes);
    await this.drain();
  }

  private async drain(): Promise<void> {
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
  cancel(): void {
    try {
      const message: ClientCancel = { type: "cancel" };
      this.send(message);
    } catch {
    }
  }

  // Data chunks are never marked last, so bytes leave as soon as the source
  // produces them; an empty chunk marked last terminates the input.
  private async upload(state: OperationState, input: InputSource | undefined): Promise<void> {
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
        await iterator.return(undefined);
      } catch {
      }
    }
  }
}

// The streams the agent may emit for an operation; anything else is a protocol
// violation.
function allowedStreams(op: string): ReadonlySet<string> {
  switch (op) {
    case "exec.run":
      return new Set(["stdout", "stderr"]);
    case "fs.read":
      return new Set(["content"]);
    case "fs.list":
      return new Set(["entries"]);
    case "http.request":
      return new Set(["body"]);
    default:
      return new Set();
  }
}

async function* readInput(input: InputSource | undefined): AsyncGenerator<Uint8Array> {
  if (input === undefined) {
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

  const stream =
    typeof Blob !== "undefined" && input instanceof Blob ? input.stream()
    : isReadableStream(input) ? input
    : null;

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

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ReadableStream<Uint8Array>).getReader === "function"
  );
}

function splitBytes(bytes: Uint8Array): Uint8Array[] {
  if (bytes.byteLength === 0 || bytes.byteLength <= MaxSendBytes) {
    return [bytes];
  }

  const pieces: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += MaxSendBytes) {
    pieces.push(bytes.subarray(offset, Math.min(offset + MaxSendBytes, bytes.byteLength)));
  }

  return pieces;
}

function inputSize(input: InputSource | undefined): number | null {
  if (input === undefined) {
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

// Progress is observational: a throwing callback is ignored, never treated as an
// upload failure.
function reportProgress(state: OperationState, sent: number, total: number | null): void {
  try {
    state.handlers.onProgress?.(sent, total);
  } catch {
  }
}

async function toBytesAsync(data: unknown): Promise<Uint8Array> {
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

function toBytes(data: unknown): Uint8Array {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
