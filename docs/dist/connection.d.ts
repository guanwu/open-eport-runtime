import type { FsEntry } from "./protocol";
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
export type InputSource = Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;
export type Invoke = <T>(op: string, params: object, handlers: StreamHandlers, input?: InputSource) => Promise<T>;
export declare const DefaultConnectTimeoutMs = 1000;
export declare class Connection {
    private readonly ws;
    private current;
    private pendingChunk;
    private receiveTail;
    private tail;
    private socketClosed;
    private closed;
    private constructor();
    static connect(url?: string, timeoutMs?: number): Promise<Connection>;
    run<T>(op: string, params: object, handlers: StreamHandlers, input?: InputSource): Promise<T>;
    close(): void;
    private enqueueMessage;
    private enqueueClose;
    private handleMessage;
    private handleText;
    private handleBinary;
    private handleTerminal;
    private receiveFailure;
    private uploadFailed;
    private protocolFailure;
    private handleClose;
    private send;
    private sendChunk;
    private drain;
    cancel(): void;
    private upload;
}
