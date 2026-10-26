// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

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

// fs.read emits content chunks and fs.list emits entries as JSON Lines; the
// other operations return only a result. Relative paths resolve against the
// agent home.
export class FilesApi {
  constructor(private readonly invoke: Invoke) {
  }

  read(params: FsReadParams, io: FsReadIo = {}): Promise<FsReadResult> {
    return this.invoke<FsReadResult>("fs.read", params, { onChunk: io.onChunk });
  }

  write(params: FsWriteParams, io: FsWriteIo = {}): Promise<FsWriteResult> {
    return this.invoke<FsWriteResult>("fs.write", params, { onProgress: io.onProgress }, io.input);
  }

  list(params: FsListParams, io: FsListIo = {}): Promise<FsListResult> {
    return this.invoke<FsListResult>("fs.list", params, { onEntry: io.onEntry });
  }

  stat(params: FsStatParams): Promise<FsStatResult> {
    return this.invoke<FsStatResult>("fs.stat", params, {});
  }

  delete(params: FsDeleteParams): Promise<EmptyResult> {
    return this.invoke<EmptyResult>("fs.delete", params, {});
  }
}

export type { FsEntry };
