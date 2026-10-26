// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChunkHandler, InputSource, Invoke, ProgressHandler } from "./connection";
import type { CookieInfo } from "./protocol";
import type { EmptyResult } from "./files";

export interface HttpRequestParams {
  url: string;
  method?: string;
  headers?: Record<string, string | string[]>;
  timeoutMs?: number;
}

export interface HttpRequestIo {
  input?: InputSource;
  onChunk?: ChunkHandler;
  onProgress?: ProgressHandler;
}

export interface HttpResult {
  status: number;
  headers: Record<string, string | string[]>;
  size: number;
  durationMs: number;
}

export interface CookiesResult {
  cookies: CookieInfo[];
}

export interface CookiesSetParams {
  cookies: CookieInfo[];
}

export class HttpCookiesApi {
  constructor(private readonly invoke: Invoke) {
  }

  get(): Promise<CookiesResult> {
    return this.invoke<CookiesResult>("http.cookies.get", {}, {});
  }

  set(params: CookiesSetParams): Promise<EmptyResult> {
    return this.invoke<EmptyResult>("http.cookies.set", params, {});
  }
}

// Response bodies stream as body chunks. Cookies live in the per-connection
// jar, so requests made through this API see cookies set by earlier ones.
export class HttpApi {
  readonly cookies: HttpCookiesApi;

  constructor(private readonly invoke: Invoke) {
    this.cookies = new HttpCookiesApi(invoke);
  }

  request(params: HttpRequestParams, io: HttpRequestIo = {}): Promise<HttpResult> {
    return this.invoke<HttpResult>(
      "http.request",
      params,
      { onChunk: io.onChunk, onProgress: io.onProgress },
      io.input,
    );
  }
}
