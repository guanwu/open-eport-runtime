// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

import type { InputSource, Invoke, ProgressHandler } from "./connection";
import type { EmptyResult } from "./files";
import type { CardDevice, CardSignature } from "./protocol";

export type { CardDevice, CardSignature };

export interface CardListResult {
  devices: CardDevice[];
}

export interface CardVerifyParams {
  // Device name as reported by card.list.
  device: string;
  // The deviceId reported for that device; it guards against opening a
  // different card.
  deviceId: string;
  // Exactly 8 UTF-8 bytes. Checked for this request only.
  pin: string;
}

export type CardSignParams = CardVerifyParams;

export interface CardSignIo {
  // Message source; an empty source signs the empty message.
  input: InputSource;
  onProgress?: ProgressHandler;
}

// Every call opens the device named by device and deviceId and closes it before
// returning. verify and sign each check the PIN for that request only, so a
// verify is not a prerequisite for a later sign.
export class CardApi {
  constructor(private readonly invoke: Invoke) {
  }

  list(): Promise<CardListResult> {
    return this.invoke<CardListResult>("card.list", {}, {});
  }

  verify(params: CardVerifyParams): Promise<EmptyResult> {
    return this.invoke<EmptyResult>("card.verify", params, {});
  }

  sign(params: CardSignParams, io: CardSignIo): Promise<CardSignature> {
    return this.invoke<CardSignature>("card.sign", params, { onProgress: io.onProgress }, io.input);
  }
}
