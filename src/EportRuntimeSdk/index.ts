// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

export { AgentClient, connect } from "./client";
export type { ConnectOptions } from "./client";

export { AgentError, ConnectionClosedError, ProtocolError } from "./errors";
export type { AgentErrorCode } from "./errors";

export { ENDPOINT, SUBPROTOCOL } from "./protocol";
export type { CardAlgorithm, CardDevice, CardSignature, CookieInfo, FsEntry, FsEntryType } from "./protocol";

export type {
  CardListResult,
  CardSignIo,
  CardSignParams,
  CardVerifyParams,
} from "./card";

export type {
  ChunkHandler,
  EntryHandler,
  InputSource,
  ProgressHandler,
  StreamHandlers,
} from "./connection";

export type {
  ExecIo,
  ExecParams,
  ExecResult,
} from "./exec";

export type {
  FsDeleteParams,
  FsListIo,
  FsListParams,
  FsListResult,
  FsReadIo,
  FsReadParams,
  FsReadResult,
  FsStatParams,
  FsStatResult,
  FsWriteIo,
  FsWriteParams,
  FsWriteResult,
  EmptyResult,
} from "./files";

export type {
  CookiesResult,
  CookiesSetParams,
  HttpRequestIo,
  HttpRequestParams,
  HttpResult,
} from "./http";
