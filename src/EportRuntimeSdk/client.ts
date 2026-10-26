// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { Connection, DefaultConnectTimeoutMs } from "./connection";
import type { Invoke } from "./connection";
import { CardApi } from "./card";
import { ConnectionClosedError } from "./errors";
import { ExecApi } from "./exec";
import { FilesApi } from "./files";
import { HttpApi } from "./http";
import { ENDPOINT } from "./protocol";
import { wake } from "./wake";

const WakeAttemptTimeoutMs = 1000;
const WakeRetryDelayMs = 250;
const WakeDeadlineMs = 5000;

export interface ConnectOptions {
  url?: string;
  // Per-attempt limit. While wake is enabled each attempt is capped at 1000 ms,
  // so a failed dial falls through to the scheme handler quickly.
  timeoutMs?: number;
  // Start the agent through its eport-runtime:// handler when a dial to the
  // default endpoint fails. Defaults to true; custom URLs are never woken.
  wake?: boolean;
}

// Public facade over one connection. exec, fs, http, and card share that
// connection, and Connection serialises their operations.
export class AgentClient {
  readonly exec: ExecApi;
  readonly fs: FilesApi;
  readonly http: HttpApi;
  readonly card: CardApi;

  private constructor(private readonly connection: Connection) {
    const invoke: Invoke = <T>(
      op: string,
      params: object,
      handlers: Parameters<Invoke>[2],
      input?: Parameters<Invoke>[3],
    ) => this.connection.run<T>(op, params, handlers, input);

    this.exec = new ExecApi(invoke);
    this.fs = new FilesApi(invoke);
    this.http = new HttpApi(invoke);
    this.card = new CardApi(invoke);
  }

  static async connect(options: ConnectOptions = {}): Promise<AgentClient> {
    const connection = await connectWithWake(options);
    return new AgentClient(connection);
  }

  // Cancels the operation in flight; its promise rejects with job.cancelled.
  cancel(): void {
    this.connection.cancel();
  }

  close(): void {
    this.connection.close();
  }
}

export function connect(options: ConnectOptions = {}): Promise<AgentClient> {
  return AgentClient.connect(options);
}

// Dial first; only a failed dial to the default endpoint launches the scheme
// handler and retries. An agent that is already running therefore connects
// without a permission prompt. The deadline bounds the retry loop because the
// browser can pause the page while its dialog is open. Custom URLs are never
// woken: this page did not start that server.
async function connectWithWake(options: ConnectOptions): Promise<Connection> {
  const url = options.url ?? ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DefaultConnectTimeoutMs;
  const wakes = url === ENDPOINT && options.wake !== false;
  const attemptTimeoutMs = wakes ? Math.min(timeoutMs, WakeAttemptTimeoutMs) : timeoutMs;

  try {
    return await Connection.connect(url, attemptTimeoutMs);
  } catch (error) {
    if (!wakes || !(error instanceof ConnectionClosedError)) {
      throw error;
    }
  }

  if (!wake()) {
    throw new ConnectionClosedError(
      "the agent is not running and cannot be started outside a browser",
    );
  }

  const deadline = Date.now() + WakeDeadlineMs;
  let lastError: ConnectionClosedError | null = null;

  while (Date.now() < deadline) {
    try {
      return await Connection.connect(url, attemptTimeoutMs);
    } catch (error) {
      if (!(error instanceof ConnectionClosedError)) {
        throw error;
      }

      lastError = error;
    }

    await delay(WakeRetryDelayMs);
  }

  throw lastError ?? new ConnectionClosedError("timed out while connecting to the agent");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
