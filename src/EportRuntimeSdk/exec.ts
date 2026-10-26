// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

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

// stdout and stderr are independent streams. Input feeds the child's stdin, and
// the call settles only after the process exits and both outputs are staged.
export class ExecApi {
  constructor(private readonly invoke: Invoke) {
  }

  run(params: ExecParams, io: ExecIo = {}): Promise<ExecResult> {
    return this.invoke<ExecResult>(
      "exec.run",
      params,
      { onStdout: io.onStdout, onStderr: io.onStderr, onProgress: io.onProgress },
      io.input,
    );
  }
}
