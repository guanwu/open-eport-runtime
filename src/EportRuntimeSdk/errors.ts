// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Error codes the protocol defines today. A newer agent may report codes this
// SDK does not know, so callers should treat the union as the known set rather
// than a closed one.
export type AgentErrorCode =
  | "request.invalid"
  | "job.cancelled"
  | "job.timeout"
  | "job.failed"
  | "agent.internal"
  | "card.notFound"
  | "card.mismatch"
  | "card.pinRejected"
  | "card.pinRequired"
  | "card.failed";

// A job ended with an agent error; code is the protocol code and message is the
// agent's description.
export class AgentError extends Error {
  readonly code: AgentErrorCode | (string & {});

  constructor(code: AgentErrorCode | (string & {}), message: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
  }
}

// The socket is closed, or the handshake failed before any operation could run.
export class ConnectionClosedError extends Error {
  constructor(message = "the agent connection is closed") {
    super(message);
    this.name = "ConnectionClosedError";
  }
}

// Framing or JSON broke the protocol; the connection cannot be used again.
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}
