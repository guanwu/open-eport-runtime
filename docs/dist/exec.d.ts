import type { ChunkHandler, InputSource, Invoke, ProgressHandler } from "./connection";
export interface ExecParams {
    file: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
}
export interface ExecIo {
    input?: InputSource;
    onStdout?: ChunkHandler;
    onStderr?: ChunkHandler;
    onProgress?: ProgressHandler;
}
export interface ExecResult {
    exitCode: number;
    durationMs: number;
}
export declare class ExecApi {
    private readonly invoke;
    constructor(invoke: Invoke);
    run(params: ExecParams, io?: ExecIo): Promise<ExecResult>;
}
