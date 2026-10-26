// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

// Manual hardware test. It starts the agent, lists the attached cards, calls
// card.verify once, signs the empty message and a 20 MiB message, and checks
// that a wrong device ID is rejected before the PIN is sent. A card and its PIN
// are required.
//
//   node tests/card.mjs <path-to-eport-runtime> 88888888

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { connect } from "../docs/dist/eport-runtime.esm.js";

const binary = process.argv[2];
const pin = process.argv[3] ?? process.env.EPORT_PIN;
const port = 26099;
const bigSize = 20 * 1024 * 1024;

if (!binary || !pin) {
  console.error("usage: node tests/card.mjs <agent-executable> <pin>");
  process.exit(2);
}

if (Buffer.byteLength(pin) !== 8) {
  console.error("the PIN must be exactly 8 UTF-8 bytes");
  process.exit(2);
}

function portOpen() {
  return new Promise((resolve) => {
    const socket = createConnection(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function checkSignature(label, signature) {
  assert.ok(
    signature.algorithm === "sm2" || signature.algorithm === "rsa-sha1",
    `${label}: unexpected algorithm ${signature.algorithm}`,
  );

  const bytes = Buffer.from(signature.signature, "base64");
  const expected = signature.algorithm === "sm2" ? 64 : 128;
  assert.equal(bytes.length, expected, `${label}: ${signature.algorithm} must be ${expected} bytes`);
  console.log(`${label}: ${signature.algorithm}, ${bytes.length} bytes`);
}

if (await portOpen()) {
  console.error(`another process is already listening on 127.0.0.1:${port}`);
  process.exit(1);
}

const agent = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let stderr = "";
agent.stderr.on("data", (data) => {
  stderr += data.toString();
});

try {
  let ready = false;
  for (let attempt = 0; attempt < 100 && !ready; attempt++) {
    await sleep(100);
    ready = await portOpen();
  }

  if (!ready) {
    throw new Error(`the agent did not start:\n${stderr}`);
  }

  const client = await connect({ wake: false });
  try {
    const { devices } = await client.card.list();
    assert.ok(devices.length > 0, "no card is attached");
    for (const device of devices) {
      console.log(`card: ${device.name}`);
      console.log(`  deviceId: ${device.deviceId}`);
      console.log(`  certificateId: ${device.certificateId}`);
    }

    const card = devices[0];
    const target = { device: card.name, deviceId: card.deviceId, pin };

    await client.card.verify(target);
    console.log("verify: accepted");

    const wrong = { ...target, deviceId: `${card.deviceId}x` };
    await assert.rejects(
      client.card.sign(wrong, { input: new Uint8Array(0) }),
      (error) => error.code === "card.mismatch",
      "a wrong device ID must report card.mismatch",
    );
    console.log("mismatch: rejected before the PIN");

    checkSignature("empty message", await client.card.sign(target, { input: new Uint8Array(0) }));

    const message = new Uint8Array(bigSize);
    for (let index = 0; index < message.length; index += 4096) {
      message[index] = (index / 4096) & 0xff;
    }

    let sent = 0;
    const signature = await client.card.sign(target, {
      input: message,
      onProgress: (progress) => {
        sent = progress;
      },
    });

    checkSignature(`${bigSize / (1024 * 1024)} MiB`, signature);
    assert.equal(sent, message.length, "the whole message must be uploaded");
    console.log("card test passed");
  } finally {
    client.close();
  }
} catch (error) {
  console.error(error);
  console.error(`agent stderr:\n${stderr}`);
  process.exitCode = 1;
} finally {
  agent.kill();
}
