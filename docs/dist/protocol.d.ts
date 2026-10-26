export declare const ENDPOINT = "ws://127.0.0.1:26099/";
export declare const SUBPROTOCOL = "eport-runtime.v1";
export interface ClientRequest {
    type: "request";
    op: string;
    params: object;
}
export interface ClientChunk {
    type: "chunk";
    last: boolean;
}
export interface ClientCancel {
    type: "cancel";
}
export type ClientText = ClientRequest | ClientChunk | ClientCancel;
export interface ServerChunk {
    type: "chunk";
    stream: string;
    last: boolean;
}
export interface ServerResult {
    type: "result";
    result: unknown;
}
export interface ServerError {
    type: "error";
    code: string;
    message: string;
}
export type FsEntryType = "file" | "dir" | "link" | "other";
export interface FsEntry {
    name: string;
    path: string;
    type: FsEntryType;
    size?: number;
    mtimeMs: number;
}
export interface CookieInfo {
    name: string;
    value: string;
    domain?: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    expiresMs?: number;
}
export type CardAlgorithm = "sm2" | "rsa-sha1";
export interface CardDevice {
    name: string;
    deviceId: string;
    certificateId: string;
}
export interface CardSignature {
    algorithm: CardAlgorithm;
    signature: string;
}
