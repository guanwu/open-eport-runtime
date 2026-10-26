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
export declare class HttpCookiesApi {
    private readonly invoke;
    constructor(invoke: Invoke);
    get(): Promise<CookiesResult>;
    set(params: CookiesSetParams): Promise<EmptyResult>;
}
export declare class HttpApi {
    private readonly invoke;
    readonly cookies: HttpCookiesApi;
    constructor(invoke: Invoke);
    request(params: HttpRequestParams, io?: HttpRequestIo): Promise<HttpResult>;
}
