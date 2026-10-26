// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

export const ENDPOINT = "ws://127.0.0.1:26099/";
export const SUBPROTOCOL = "eport-runtime.v1";

// Wire format: every Text frame is JSON. A chunk header announces exactly one
// Binary frame with that stream's bytes, and entry streams carry JSON Lines.
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
  // Base64 of the card-order signature: 64 bytes for SM2, 128 for RSA-SHA1.
  signature: string;
}
