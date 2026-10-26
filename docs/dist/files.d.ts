import type { ChunkHandler, EntryHandler, InputSource, ProgressHandler } from "./connection";
import type { FsEntry } from "./protocol";
import type { Invoke } from "./connection";
export type EmptyResult = Record<string, never>;
export interface FsReadParams {
    path: string;
}
export interface FsWriteParams {
    path: string;
}
export interface FsListParams {
    path: string;
    recursive?: boolean;
}
export interface FsStatParams {
    path: string;
}
export interface FsDeleteParams {
    path: string;
    recursive?: boolean;
}
export interface FsReadResult {
    size: number;
}
export interface FsWriteResult {
    path: string;
    size: number;
}
export interface FsListResult {
    count: number;
}
export interface FsStatResult {
    type: "file" | "dir" | "other";
    size: number;
    mtimeMs: number;
}
export interface FsReadIo {
    onChunk?: ChunkHandler;
}
export interface FsWriteIo {
    input?: InputSource;
    onProgress?: ProgressHandler;
}
export interface FsListIo {
    onEntry?: EntryHandler;
}
export declare class FilesApi {
    private readonly invoke;
    constructor(invoke: Invoke);
    read(params: FsReadParams, io?: FsReadIo): Promise<FsReadResult>;
    write(params: FsWriteParams, io?: FsWriteIo): Promise<FsWriteResult>;
    list(params: FsListParams, io?: FsListIo): Promise<FsListResult>;
    stat(params: FsStatParams): Promise<FsStatResult>;
    delete(params: FsDeleteParams): Promise<EmptyResult>;
}
export type { FsEntry };
