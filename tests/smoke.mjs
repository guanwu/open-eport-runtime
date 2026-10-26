// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

// End-to-end test. It starts a published agent binary and a local HTTP server,
// then exercises the raw protocol and the SDK. Requires
// docs/dist/eport-runtime.iife.min.js, and 127.0.0.1:26099 must be free.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("..", import.meta.url));
const endpoint = "ws://127.0.0.1:26099/";
const isWindows = process.platform === "win32";
const empty = new Uint8Array(0);

let binaryPath;
let work;
let linkRoot;
let agent = null;
let agentExit = null;
let agentStderr = "";
let httpServer = null;
let httpBase = "";
let httpRequests = null;
let redirectHops = 0;
let rawAgent = null;
let sdk = null;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function section(name) {
  console.log(`\n# ${name}`);
}

function streamBytes(streams, name) {
  const stream = streams.get(name);
  return stream === undefined ? null : Buffer.concat(stream.chunks);
}

function streamText(streams, name) {
  const bytes = streamBytes(streams, name);
  return bytes === null ? null : bytes.toString("utf8");
}

function parseEntries(streams) {
  const bytes = streamBytes(streams, "entries");
  if (bytes === null) {
    return [];
  }

  const lines = bytes.toString("utf8").split("\n");
  assert.equal(lines.pop(), "", "the entries stream must end with a newline");

  return lines.filter((line) => line.length > 0).map((line) => JSON.parse(line));
}

function hash(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function resolveBinary() {
  const requested = process.argv[2] ?? process.env.GUANWU_AGENT;
  if (requested === undefined) {
    throw new Error(
      "the agent binary was not found; pass its path as the first argument or set GUANWU_AGENT",
    );
  }

  const absolute = path.resolve(root, requested);
  try {
    await fs.access(absolute);
    return absolute;
  } catch {
    throw new Error(`the agent binary was not found at ${absolute}`);
  }
}

async function tcpOpen() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: 26099 });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 500);

    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function waitForPort(exitPromise) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (agentExit !== null) {
      throw new Error(`the agent exited with code ${agentExit.code} before listening:\n${agentStderr}`);
    }

    if (await tcpOpen()) {
      return;
    }

    await sleep(100);
  }

  throw new Error(`the agent did not listen on ${endpoint} within 10 seconds:\n${agentStderr}`);
}

async function expectCode(promise, code, label) {
  try {
    await promise;
  } catch (error) {
    assert.equal(error.code, code, `${label}: expected ${code}, got ${error.code ?? "<none>"} (${error.message})`);
    return error;
  }

  assert.fail(`${label}: expected ${code}, but the operation succeeded`);
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

function queryRegistry(args) {
  try {
    return execFileSync("reg", args, { encoding: "utf8" });
  } catch {
    return null;
  }
}

// Windows packaging checks: subsystem 2 keeps the console hidden, and the
// per-user eport-runtime:// command lets a page relaunch this exact binary.
async function testWindowsImage() {
  section("windows image");

  if (!isWindows) {
    console.log("skipped: the Windows image checks are Windows-only");
    return;
  }

  const image = await fs.readFile(binaryPath);
  const pe = image.readUInt32LE(0x3c);
  assert.equal(image.readUInt16LE(pe), 0x4550, "the agent must be a PE image");
  const optional = pe + 24;
  const magic = image.readUInt16LE(optional);
  assert.ok(magic === 0x10b || magic === 0x20b, "the agent must have a PE optional header");
  assert.equal(image.readUInt16LE(optional + 68), 2, "the agent must use the Windows GUI subsystem");

  const key = "HKCU\\Software\\Classes\\eport-runtime";
  const protocol = queryRegistry(["query", key, "/v", "URL Protocol"]);
  assert.notEqual(protocol, null, "eport-runtime:// must be registered for the current user");
  assert.match(protocol, /REG_SZ/, "URL Protocol must be a string value");

  const command = queryRegistry(["query", `${key}\\shell\\open\\command`, "/ve"]);
  assert.notEqual(command, null, "the eport-runtime:// open command must be registered");
  const value = command.split(/\r?\n/).find((line) => line.includes("REG_SZ"));
  assert.ok(value !== undefined, "the eport-runtime:// open command must be a string value");
  assert.ok(
    value.toLowerCase().includes(`"${binaryPath}" "%1"`.toLowerCase()),
    `the eport-runtime:// command must point at ${binaryPath}`,
  );
}

async function waitForMissing(target, label, timeout = 5000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (!(await pathExists(target))) {
      return;
    }

    await sleep(100);
  }

  assert.fail(`${label}: ${target} still exists`);
}

async function waitForEmptyDirectory(target, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let entries = null;

  while (Date.now() < deadline) {
    entries = await fs.readdir(target).catch(() => null);
    if (entries !== null && entries.length === 0) {
      return;
    }

    await sleep(100);
  }

  assert.deepEqual(entries, [], `${label}: ${target} is not empty`);
}

// A path can have several spellings (8.3 names, /var versus /private/var, a
// linked parent). Compare the device and inode, not the text.
async function assertSamePath(actual, expected, message) {
  assert.ok(path.isAbsolute(actual), `${message}: ${actual} is not absolute`);
  const [left, right] = await Promise.all([
    fs.stat(actual, { bigint: true }),
    fs.stat(expected, { bigint: true }),
  ]);
  assert.equal(left.dev, right.dev, message);
  assert.equal(left.ino, right.ino, message);
}

// Collects frames in arrival order, separately from any assembled result, so
// tests can assert on chunk framing and close codes.
class RawClient {
  static async open() {
    const socket = new WebSocket(endpoint, "eport-runtime.v1");
    socket.binaryType = "arraybuffer";

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket open timed out")), 5000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("WebSocket failed to open"));
      }, { once: true });
    });

    return new RawClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.queue = [];
    this.readers = [];
    this.closeInfo = null;
    this.closeReaders = [];

    socket.addEventListener("message", (event) => {
      const item = typeof event.data === "string"
        ? { kind: "text", text: event.data }
        : { kind: "binary", bytes: Buffer.from(new Uint8Array(event.data)) };
      const reader = this.readers.shift();
      if (reader !== undefined) {
        reader.resolve(item);
      } else {
        this.queue.push(item);
      }
    });

    socket.addEventListener("close", (event) => {
      this.closeInfo = { code: event.code, reason: event.reason };
      for (const reader of this.readers.splice(0)) {
        reader.reject(new Error(`the connection closed with code ${event.code}`));
      }

      for (const resolve of this.closeReaders.splice(0)) {
        resolve(this.closeInfo);
      }
    });

    socket.addEventListener("error", () => {
    });
  }

  sendJson(message) {
    this.socket.send(JSON.stringify(message));
  }

  sendBinary(bytes) {
    this.socket.send(bytes);
  }

  sendChunk(last, bytes) {
    this.sendJson({ type: "chunk", last });
    this.sendBinary(bytes ?? empty);
  }

  sendRequest(op, params) {
    this.sendJson({ type: "request", op, params });
  }

  sendInput(pieces) {
    if (pieces.length === 0) {
      this.sendChunk(true, empty);
      return;
    }

    pieces.forEach((piece, index) => {
      this.sendChunk(index === pieces.length - 1, piece);
    });
  }

  next() {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift());
    }

    if (this.closeInfo !== null) {
      return Promise.reject(new Error(`the connection closed with code ${this.closeInfo.code}`));
    }

    return new Promise((resolve, reject) => {
      this.readers.push({ resolve, reject });
    });
  }

  async nextText() {
    const item = await this.next();
    assert.equal(item.kind, "text", "expected a text message");
    return item.text;
  }

  async nextBinary() {
    const item = await this.next();
    assert.equal(item.kind, "binary", "expected a binary message after a chunk header");
    return item.bytes;
  }

  async run(op, params, pieces = []) {
    this.sendRequest(op, params);
    this.sendInput(pieces);
    return this.readJob();
  }

  async readJob(onStream) {
    const streams = new Map();

    while (true) {
      const message = JSON.parse(await this.nextText());

      if (message.type === "chunk") {
        assert.equal(typeof message.stream, "string", "chunk.stream must be a string");
        assert.equal(typeof message.last, "boolean", "chunk.last must be a boolean");
        const bytes = await this.nextBinary();
        let stream = streams.get(message.stream);
        if (stream === undefined) {
          stream = { chunks: [], bytes: 0, last: false };
          streams.set(message.stream, stream);
        }

        stream.chunks.push(bytes);
        stream.bytes += bytes.length;
        if (message.last) {
          stream.last = true;
        }

        onStream?.(message.stream, bytes, message.last);
        continue;
      }

      if (message.type === "result") {
        return { result: message.result, streams };
      }

      if (message.type === "error") {
        const error = new Error(message.message);
        error.code = message.code;
        throw error;
      }

      assert.fail(`unexpected server message type: ${message.type}`);
    }
  }

  waitClosed() {
    if (this.closeInfo !== null) {
      return Promise.resolve(this.closeInfo);
    }

    return new Promise((resolve) => this.closeReaders.push(resolve));
  }

  close() {
    try {
      this.socket.close(1000, "smoke test");
    } catch {
    }
  }
}

async function openRaw() {
  return await RawClient.open();
}

async function withClient(action) {
  const client = await openRaw();
  try {
    return await action(client);
  } finally {
    client.close();
  }
}

function probeUpgrade(request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(26099, "127.0.0.1");
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("handshake probe timed out"));
    }, 5000);
    let data = "";

    socket.on("data", (chunk) => {
      data += chunk.toString("latin1");
      if (data.includes("\r\n\r\n")) {
        clearTimeout(timer);
        socket.destroy();
        resolve(data);
      }
    });

    socket.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    socket.once("connect", () => {
      socket.write(request);
    });
  });
}

function upgradeRequest({ protocol = "eport-runtime.v1", pathName = "/" } = {}) {
  const lines = [
    `GET ${pathName} HTTP/1.1`,
    "Host: 127.0.0.1:26099",
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
  ];

  if (protocol !== null) {
    lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
  }

  return lines.join("\r\n") + "\r\n\r\n";
}

async function startHttpServer() {
  const requests = [];
  httpRequests = requests;

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });

      const route = request.url.split("?")[0];
      switch (route) {
        case "/echo":
          response.writeHead(200, {
            "content-type": "application/octet-stream",
            "x-echo-method": request.method,
          });
          response.end(body);
          return;

        case "/method":
          response.writeHead(200, { "content-type": "text/plain" });
          response.end(request.method);
          return;

        case "/headers":
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(request.headers));
          return;

        case "/cookies":
          response.setHeader("set-cookie", [
            "a=1; Path=/",
            "b=2; Path=/; HttpOnly",
          ]);
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("cookies");
          return;

        case "/multi":
          response.setHeader("x-multi", ["one", "two"]);
          response.setHeader("set-cookie", [
            "m=1; Path=/",
            "n=2; Path=/",
          ]);
          response.writeHead(200, { "content-type": "text/plain" });
          response.end("multi");
          return;

        case "/redirect-post":
          response.writeHead(302, { location: "/method" });
          response.end();
          return;

        case "/redirect-post-headers":
          response.writeHead(302, { location: "/headers" });
          response.end();
          return;

        case "/redirect-307":
          response.writeHead(307, { location: "/echo" });
          response.end();
          return;

        case "/redirect-ftp":
          response.writeHead(302, { location: "ftp://example.invalid/file" });
          response.end();
          return;

        case "/no-location":
          response.writeHead(302);
          response.end();
          return;

        case "/redirect-count": {
          const hop = Number(new URL(request.url, "http://127.0.0.1").searchParams.get("hop") ?? "0");
          redirectHops = Math.max(redirectHops, hop);
          if (hop >= 60) {
            response.writeHead(200);
            response.end("too many");
            return;
          }
          response.writeHead(302, { location: `/redirect-count?hop=${hop + 1}` });
          response.end();
          return;
        }

        case "/auth-redirect":
          response.writeHead(302, { location: "/headers" });
          response.end();
          return;

        case "/gzip":
          response.writeHead(200, {
            "content-type": "text/plain",
            "content-encoding": "gzip",
          });
          response.end(gzipSync(Buffer.from("decompressed text")));
          return;

        case "/status404":
          response.writeHead(404, { "content-type": "text/plain" });
          response.end("not here");
          return;

        case "/empty":
          response.writeHead(200);
          response.end();
          return;

        case "/slow": {
          const timer = setTimeout(() => {
            response.writeHead(200);
            response.end("too late");
          }, 10_000);
          response.on("close", () => clearTimeout(timer));
          return;
        }

        default:
          response.writeHead(404);
          response.end();
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  httpServer = server;
  httpBase = `http://127.0.0.1:${server.address().port}`;
  return requests;
}

async function findClosedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function testErrorCodes() {
  section("error codes");

  const codes = async (file, className) => {
    let source = await fs.readFile(path.join(root, file), "utf8");
    if (className) {
      const start = source.indexOf(`class ${className}`);
      const end = source.indexOf("\n}", start);
      assert.ok(start >= 0 && end > start, `${file} must define ${className}`);
      source = source.slice(start, end);
    }
    const found = [...source.matchAll(/"([a-z]+\.[a-zA-Z]+)"/g)].map((match) => match[1]);
    return [...new Set(found)].sort();
  };

  const protocol = await fs.readFile(path.join(root, "PROTOCOL.md"), "utf8");
  const start = protocol.indexOf("### 6.1");
  const end = protocol.indexOf("### 6.2");
  assert.ok(start >= 0 && end > start, "PROTOCOL.md must define the error code table");

  const documented = [...protocol.slice(start, end).matchAll(/^\| `([^`]+)` \|/gm)]
    .map((match) => match[1])
    .sort();
  assert.equal(documented.length, 10, "the protocol must document ten error codes");

  const backend = await codes("src/EportRuntime/Protocol.cs", "ErrorCodes");
  const sdkCodes = await codes("src/EportRuntimeSdk/errors.ts");

  assert.deepEqual(backend, documented, "the agent must implement every documented error code");
  assert.deepEqual(sdkCodes, backend, "the SDK error codes must match the agent's");
}

async function testHandshake() {
  section("handshake");

  const missing = await probeUpgrade(upgradeRequest({ protocol: null }));
  assert.match(missing, /^HTTP\/1\.1 400 Bad Request/, "a handshake without a subprotocol must be rejected");

  const wrong = await probeUpgrade(upgradeRequest({ protocol: "eport-runtime.v2" }));
  assert.match(wrong, /^HTTP\/1\.1 400 Bad Request/, "a handshake with an unknown subprotocol must be rejected");

  const wrongPath = await probeUpgrade(upgradeRequest({ pathName: "/other" }));
  assert.match(wrongPath, /^HTTP\/1\.1 400 Bad Request/, "only the root path is served");

  const accepted = await probeUpgrade(upgradeRequest());
  assert.match(accepted, /^HTTP\/1\.1 101 Switching Protocols/, "a valid handshake must upgrade");
  assert.match(accepted, /Sec-WebSocket-Protocol: eport-runtime\.v1/i, "the server must select eport-runtime.v1");
}

async function testFiles(client) {
  section("fs");

  const bigPath = path.join(work, "big.bin");
  const big = randomBytes(2 * 1024 * 1024);
  const written = await client.run("fs.write", { path: bigPath }, [
    big.subarray(0, 700_000),
    big.subarray(700_000),
  ]);
  await assertSamePath(written.result.path, bigPath, "fs.write must report the absolute target path");
  assert.equal(written.result.size, big.length, "fs.write must report the input size");
  assert.equal(hash(await fs.readFile(bigPath)), hash(big), "fs.write must store the exact bytes");
  assert.deepEqual(
    (await fs.readdir(work)).filter((name) => name.startsWith(".eport-")),
    [],
    "fs.write must not leave a .part file behind",
  );

  const bigStat = (await client.run("fs.stat", { path: bigPath })).result;
  assert.equal(bigStat.type, "file", "fs.stat must report a file");
  assert.equal(bigStat.size, big.length, "fs.stat must report the file size");
  assert.equal(typeof bigStat.mtimeMs, "number", "fs.stat must report mtimeMs");

  const read = await client.run("fs.read", { path: bigPath });
  const readContent = streamBytes(read.streams, "content");
  assert.notEqual(readContent, null, "fs.read must open the content stream");
  assert.equal(read.streams.get("content").last, true, "the content stream must end with last");
  assert.equal(readContent.length, big.length, "fs.read must report every byte");
  assert.equal(hash(readContent), hash(big), "fs.read must return the exact bytes");
  assert.equal(read.result.size, big.length, "fs.read must report the size");
  assert.ok(read.streams.get("content").chunks.length > 1, "fs.read must stream in several chunks");

  const emptyPath = path.join(work, "empty.bin");
  const emptyWrite = await client.run("fs.write", { path: emptyPath });
  assert.equal(emptyWrite.result.size, 0, "an empty fs.write must report size 0");
  assert.deepEqual(await fs.readFile(emptyPath), Buffer.alloc(0), "an empty fs.write must create an empty file");
  const emptyRead = await client.run("fs.read", { path: emptyPath });
  assert.equal(emptyRead.result.size, 0, "an empty fs.read must report size 0");
  assert.equal(streamBytes(emptyRead.streams, "content"), null, "an empty fs.read must not open the content stream");

  const tree = path.join(work, "tree");
  await fs.mkdir(path.join(tree, "sub"), { recursive: true });
  await fs.writeFile(path.join(tree, "root.txt"), "root");
  await fs.writeFile(path.join(tree, "sub", "nested.txt"), "nested");

  const flat = await client.run("fs.list", { path: tree });
  const flatEntries = parseEntries(flat.streams);
  const flatNames = new Set(flatEntries.map((entry) => entry.name));
  assert.equal(flat.result.count, 2, "a non-recursive list must count direct children");
  assert.deepEqual(flatNames, new Set(["root.txt", "sub"]), "a non-recursive list must not descend");
  const rootEntry = flatEntries.find((entry) => entry.name === "root.txt");
  assert.equal(rootEntry.type, "file", "a file entry must have type file");
  assert.equal(rootEntry.size, 4, "a file entry must carry its size");
  await assertSamePath(rootEntry.path, path.join(tree, "root.txt"), "an entry must carry an absolute path");
  for (const chunk of flat.streams.get("entries").chunks) {
    assert.equal(chunk[chunk.length - 1], 0x0a, "every entries Binary message must contain whole lines");
  }

  const nested = await client.run("fs.list", { path: tree, recursive: true });
  const nestedNames = new Set(parseEntries(nested.streams).map((entry) => entry.name));
  assert.equal(nested.result.count, 3, "a recursive list must count nested entries");
  assert.ok(nestedNames.has("nested.txt"), "a recursive list must include nested files");

  const emptyDir = path.join(work, "empty-dir");
  await fs.mkdir(emptyDir);
  const emptyList = await client.run("fs.list", { path: emptyDir });
  assert.equal(emptyList.result.count, 0, "an empty directory must list zero entries");
  assert.equal(streamBytes(emptyList.streams, "entries"), null, "an empty list must not open the entries stream");

  await expectCode(client.run("fs.delete", { path: tree }), "job.failed", "deleting a non-empty directory without recursion");
  await client.run("fs.delete", { path: tree, recursive: true });
  await waitForMissing(tree, "recursive fs.delete");

  const writeDirectory = await expectCode(
    client.run("fs.write", { path: emptyDir }),
    "job.failed",
    "writing a directory",
  );
  assert.match(writeDirectory.message, /directory/i);

  for (const op of ["fs.read", "fs.stat", "fs.list", "fs.delete"]) {
    await expectCode(client.run(op, { path: path.join(work, "missing") }), "job.failed", `${op} on a missing path`);
  }

  await expectCode(
    client.run("fs.read", { path: "bad\u0000path" }),
    "request.invalid",
    "fs.read with a malformed path",
  );
}

async function testSymlinks(client) {
  section("symlinks");

  linkRoot = await fs.mkdtemp(path.join(os.tmpdir(), "eport-smoke-link-"));
  const targetDir = path.join(linkRoot, "target");
  await fs.mkdir(targetDir);
  await fs.writeFile(path.join(targetDir, "keep.txt"), "keep");

  const directoryLink = path.join(work, "directory-link");
  const junctionType = isWindows ? "junction" : "dir";
  try {
    await fs.symlink(targetDir, directoryLink, junctionType);
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOSYS") {
      console.log(`skipped: cannot create a directory link (${error.code})`);
      return;
    }

    throw error;
  }

  const listed = await client.run("fs.list", { path: work, recursive: true });
  const linkEntry = parseEntries(listed.streams).find((entry) => entry.name === path.basename(directoryLink));
  assert.notEqual(linkEntry, undefined, "fs.list must report the link");
  await assertSamePath(linkEntry.path, directoryLink, "the link entry must carry the absolute link path");
  assert.equal(linkEntry.type, "link", "fs.list must report a link as link");
  assert.equal("size" in linkEntry, false, "a link entry must omit size");

  const recursiveNames = new Set(parseEntries(listed.streams).map((entry) => entry.name));
  assert.equal(recursiveNames.has("keep.txt"), false, "fs.list must not follow a link");

  const linkStat = (await client.run("fs.stat", { path: directoryLink })).result;
  assert.equal(linkStat.type, "dir", "fs.stat must follow a link");

  const targetList = await client.run("fs.list", { path: directoryLink });
  assert.equal(targetList.result.count, 1, "fs.list must list the link target when it is the root");

  await client.run("fs.delete", { path: directoryLink });
  await waitForMissing(directoryLink, "deleting a directory link");
  assert.equal(await fs.readFile(path.join(targetDir, "keep.txt"), "utf8"), "keep", "deleting a link must keep its target");

  const writeLink = path.join(work, "directory-link-write");
  await fs.symlink(targetDir, writeLink, junctionType);
  const replaced = await client.run("fs.write", { path: writeLink }, [Buffer.from("replacement")]);
  await assertSamePath(replaced.result.path, writeLink, "fs.write must report the link path");
  const replacedStat = await fs.lstat(writeLink);
  assert.equal(replacedStat.isFile(), true, "fs.write must replace the link with a regular file");
  assert.equal(await fs.readFile(writeLink, "utf8"), "replacement", "fs.write must write through the replaced link path");
  assert.equal(await fs.readFile(path.join(targetDir, "keep.txt"), "utf8"), "keep", "fs.write must not write into the link target");

  const targetFile = path.join(work, "link-target.txt");
  await fs.writeFile(targetFile, "original");
  const fileLink = path.join(work, "file-link.txt");
  try {
    await fs.symlink(targetFile, fileLink, "file");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOSYS") {
      console.log(`skipped: cannot create a file link (${error.code})`);
      return;
    }

    throw error;
  }

  const fileLinkStat = (await client.run("fs.stat", { path: fileLink })).result;
  assert.equal(fileLinkStat.type, "file", "fs.stat must follow a file link");
  assert.equal(fileLinkStat.size, 8, "fs.stat must report the target size");

  const fileLinkRead = await client.run("fs.read", { path: fileLink });
  assert.equal(streamText(fileLinkRead.streams, "content"), "original", "fs.read must follow a file link");

  await client.run("fs.write", { path: fileLink }, [Buffer.from("via link")]);
  assert.equal((await fs.lstat(fileLink)).isFile(), true, "fs.write must replace a file link");
  assert.equal(await fs.readFile(fileLink, "utf8"), "via link", "fs.write must replace the link itself");
  assert.equal(await fs.readFile(targetFile, "utf8"), "original", "fs.write must not modify the file link target");

  const fileLinkDelete = path.join(work, "file-link-delete.txt");
  await fs.symlink(targetFile, fileLinkDelete, "file");
  await client.run("fs.delete", { path: fileLinkDelete });
  await waitForMissing(fileLinkDelete, "deleting a file link");
  assert.equal(await fs.readFile(targetFile, "utf8"), "original", "deleting a file link must keep its target");
}

async function testExec(client) {
  section("exec");

  const node = process.execPath;
  const echoScript = [
    "let data = '';",
    "process.stdin.on('data', (chunk) => data += chunk);",
    "process.stdin.on('end', () => {",
    "  process.stdout.write('OUT:' + data);",
    "  process.stderr.write('ERR:' + data.length);",
    "});",
  ].join("");

  const echoed = await client.run("exec.run", { file: node, args: ["-e", echoScript] }, [
    Buffer.from("hello stdin"),
  ]);
  assert.equal(echoed.result.exitCode, 0, "exec.run must report exit code 0");
  assert.equal(typeof echoed.result.durationMs, "number", "exec.run must report durationMs");
  assert.equal(streamText(echoed.streams, "stdout"), "OUT:hello stdin", "stdout must carry the input");
  assert.equal(streamText(echoed.streams, "stderr"), "ERR:11", "stderr must be separate from stdout");
  assert.equal(echoed.streams.get("stdout").last, true, "stdout must end with last");
  assert.equal(echoed.streams.get("stderr").last, true, "stderr must end with last");

  const inspectScript = [
    "process.stdout.write(JSON.stringify({",
    "  cwd: process.cwd(),",
    "  value: process.env.GW_SMOKE,",
    "  args: process.argv.slice(1),",
    "}));",
  ].join("");
  const inspected = await client.run("exec.run", {
    file: node,
    args: ["-e", inspectScript, "a b", "--flag"],
    cwd: work,
    env: { GW_SMOKE: "yes" },
  });
  const info = JSON.parse(streamText(inspected.streams, "stdout"));
  await assertSamePath(info.cwd, path.resolve(work), "exec.run must use cwd");
  assert.equal(info.value, "yes", "exec.run must apply the environment overlay");
  assert.deepEqual(info.args, ["a b", "--flag"], "exec.run must pass arguments as a vector");

  const defaultCwd = await client.run("exec.run", {
    file: node,
    args: ["-e", "process.stdout.write(process.cwd())"],
  });
  await assertSamePath(
    streamText(defaultCwd.streams, "stdout"),
    path.dirname(binaryPath),
    "the default working directory must be AgentHome",
  );

  const bigOut = await client.run("exec.run", {
    file: node,
    args: ["-e", "process.stdout.write('x'.repeat(300 * 1024))"],
  });
  const bigOutBytes = streamBytes(bigOut.streams, "stdout");
  assert.equal(bigOutBytes.length, 300 * 1024, "exec.run must stream large stdout");
  assert.equal(bigOut.streams.get("stdout").last, true, "large stdout must end with last");

  const failed = await client.run("exec.run", {
    file: node,
    args: ["-e", "process.exit(3)"],
  });
  assert.equal(failed.result.exitCode, 3, "a non-zero exit code must be a result");

  await expectCode(
    client.run("exec.run", { file: "eport-runtime-does-not-exist" }),
    "job.failed",
    "exec.run with a missing executable",
  );

  await expectCode(
    client.run("exec.run", { file: "" }),
    "request.invalid",
    "exec.run with an empty executable name",
  );

  const bare = await client.run("exec.run", { file: "eport-runtime" });
  assert.equal(bare.result.exitCode, 0, "a bare executable name must resolve from AgentHome");

  await expectCode(
    client.run("exec.run", {
      file: node,
      args: ["-e", "setTimeout(() => {}, 5000)"],
      timeoutMs: 300,
    }),
    "job.timeout",
    "exec.run timeout",
  );

  const marker = path.join(work, "cancel-marker.txt");
  const cancelChild = path.join(work, "cancel-child.cjs");
  await fs.writeFile(
    cancelChild,
    `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), 1500);\n`,
  );
  const cancelScript = [
    "const { spawn } = require('child_process');",
    `spawn(process.execPath, [${JSON.stringify(cancelChild)}]);`,
    "setInterval(() => {}, 1000);",
  ].join("");
  client.sendRequest("exec.run", { file: node, args: ["-e", cancelScript] });
  client.sendInput([]);
  await sleep(300);
  client.sendJson({ type: "cancel" });
  await expectCode(client.readJob(), "job.cancelled", "exec.run cancel");
  await sleep(1800);
  await waitForMissing(marker, "a cancelled process tree", 1000);

  const closeMarker = path.join(work, "close-marker.txt");
  const closeChild = path.join(work, "close-child.cjs");
  await fs.writeFile(
    closeChild,
    `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(closeMarker)}, "x"), 1500);\n`,
  );
  const closeScript = [
    "const { spawn } = require('child_process');",
    `spawn(process.execPath, [${JSON.stringify(closeChild)}]);`,
    "setInterval(() => {}, 1000);",
  ].join("");
  const closing = await openRaw();
  closing.sendRequest("exec.run", { file: node, args: ["-e", closeScript] });
  closing.sendInput([]);
  await sleep(300);
  closing.close();
  await closing.waitClosed();
  await sleep(1800);
  await waitForMissing(closeMarker, "a process tree after connection close", 1000);
}

async function testHttp(client) {
  section("http");

  const initialCookies = (await client.run("http.cookies.get", {})).result.cookies;
  assert.deepEqual(initialCookies, [], "a new connection must start with an empty cookie jar");

  const get = await client.run("http.request", { url: `${httpBase}/echo` });
  assert.equal(get.result.status, 200, "http.request must report the status");
  assert.equal(get.result.size, 0, "an empty response must report size 0");
  assert.equal(streamBytes(get.streams, "body"), null, "an empty response must not open the body stream");
  assert.equal(get.result.headers["content-type"], "application/octet-stream", "response headers must be lowercase");

  const payload = randomBytes(100 * 1024);
  const posted = await client.run("http.request", { url: `${httpBase}/echo`, method: "POST" }, [payload]);
  const echoed = streamBytes(posted.streams, "body");
  assert.equal(posted.result.status, 200);
  assert.equal(posted.result.size, payload.length, "http.request must report the response size");
  assert.equal(hash(echoed), hash(payload), "http.request must send and receive the exact body");
  assert.equal(posted.streams.get("body").last, true, "the body stream must end with last");

  const getHeaders = JSON.parse(streamText((await client.run("http.request", { url: `${httpBase}/headers` })).streams, "body"));
  assert.equal("content-length" in getHeaders, false, "an empty GET must not send content-length");

  const emptyPost = await client.run("http.request", { url: `${httpBase}/headers`, method: "POST" });
  const emptyPostHeaders = JSON.parse(streamText(emptyPost.streams, "body"));
  assert.equal(emptyPostHeaders["content-length"], "0", "an empty POST must send content-length: 0");

  const multi = await client.run("http.request", { url: `${httpBase}/multi` });
  assert.ok(Array.isArray(multi.result.headers["set-cookie"]), "repeated Set-Cookie headers must be an array");
  assert.equal(multi.result.headers["set-cookie"].length, 2);
  assert.ok(Array.isArray(multi.result.headers["x-multi"]), "repeated headers must be an array");
  assert.deepEqual(multi.result.headers["x-multi"], ["one", "two"]);

  await client.run("http.cookies.set", { cookies: [] });
  await client.run("http.request", { url: `${httpBase}/cookies` });
  const stored = (await client.run("http.cookies.get", {})).result.cookies;
  assert.deepEqual(new Set(stored.map((cookie) => cookie.name)), new Set(["a", "b"]), "Set-Cookie must be stored");
  const cookieB = stored.find((cookie) => cookie.name === "b");
  assert.equal(cookieB.httpOnly, true, "httpOnly must be reported");
  assert.equal(cookieB.secure, false, "secure must default to false");

  const afterCookies = JSON.parse(streamText((await client.run("http.request", { url: `${httpBase}/headers` })).streams, "body"));
  assert.match(afterCookies.cookie, /(?:^|; )a=1(?:;|$)/, "stored cookies must be sent");
  assert.match(afterCookies.cookie, /(?:^|; )b=2(?:;|$)/, "stored cookies must be sent");

  await client.run("http.cookies.set", {
    cookies: [
      { name: "c", value: "3", path: "/" },
      { name: "d", value: "4", domain: "127.0.0.1", path: "/" },
      { name: "s", value: "5", path: "/", secure: true },
    ],
  });
  const replacedCookies = (await client.run("http.cookies.get", {})).result.cookies;
  assert.deepEqual(new Set(replacedCookies.map((cookie) => cookie.name)), new Set(["c", "d", "s"]));
  const replacedHeaders = JSON.parse(streamText((await client.run("http.request", { url: `${httpBase}/headers` })).streams, "body"));
  assert.match(replacedHeaders.cookie, /(?:^|; )c=3(?:;|$)/, "a domain-less cookie must match every host");
  assert.match(replacedHeaders.cookie, /(?:^|; )d=4(?:;|$)/, "a domain cookie must match its host");
  assert.equal(/s=5/.test(replacedHeaders.cookie ?? ""), false, "a secure cookie must not be sent over http");

  await client.run("http.cookies.set", { cookies: [] });
  assert.deepEqual((await client.run("http.cookies.get", {})).result.cookies, [], "an empty set must clear the jar");
  const clearedHeaders = JSON.parse(streamText((await client.run("http.request", { url: `${httpBase}/headers` })).streams, "body"));
  assert.equal("cookie" in clearedHeaders, false, "a cleared jar must not send a Cookie header");

  const redirected = await client.run("http.request", { url: `${httpBase}/redirect-post`, method: "POST" }, [Buffer.from("ignored")]);
  assert.equal(redirected.result.status, 200, "a redirect must be followed");
  assert.equal(streamText(redirected.streams, "body"), "GET", "302 must turn POST into GET");
  assert.equal(redirected.result.size, 3);
  const redirectedRequest = httpRequests.at(-1);
  assert.equal(redirectedRequest.method, "GET", "302 must send a GET");
  assert.equal(redirectedRequest.body.length, 0, "302 must drop the request body");

  const contentTyped = await client.run("http.request", {
    url: `${httpBase}/redirect-post-headers`,
    method: "POST",
    headers: { "Content-Type": "text/plain", "X-Keep": "yes" },
  }, [Buffer.from("ignored")]);
  assert.equal(contentTyped.result.status, 200, "a redirect with content headers must be followed");
  const contentTypedHeaders = JSON.parse(streamText(contentTyped.streams, "body"));
  assert.equal("content-type" in contentTypedHeaders, false, "a bodyless redirect must drop content headers");
  assert.equal(contentTypedHeaders["x-keep"], "yes", "a bodyless redirect must keep other headers");

  const preserved = await client.run("http.request", { url: `${httpBase}/redirect-307`, method: "POST" }, [Buffer.from("kept")]);
  assert.equal(streamText(preserved.streams, "body"), "kept", "307 must preserve the method and body");
  const preservedRequest = httpRequests.at(-1);
  assert.equal(preservedRequest.method, "POST", "307 must preserve the request method");
  assert.equal(preservedRequest.body.toString("utf8"), "kept", "307 must resend the request body");

  const auth = await client.run("http.request", {
    url: `${httpBase}/auth-redirect`,
    headers: { Authorization: "Bearer secret", "X-Keep": "yes" },
  });
  const authHeaders = JSON.parse(streamText(auth.streams, "body"));
  assert.equal("authorization" in authHeaders, false, "Authorization must be cleared on a redirect");
  assert.equal(authHeaders["x-keep"], "yes", "other headers must survive a redirect");

  const noLocation = await client.run("http.request", { url: `${httpBase}/no-location` });
  assert.equal(noLocation.result.status, 302, "a 3xx without Location must be a result");

  const ftp = await client.run("http.request", { url: `${httpBase}/redirect-ftp` });
  assert.equal(ftp.result.status, 302, "a redirect to an unsupported scheme must be a result");

  redirectHops = 0;
  const loop = await client.run("http.request", { url: `${httpBase}/redirect-count` });
  assert.equal(loop.result.status, 302, "a request over the redirect limit must return the last response");
  assert.equal(redirectHops, 50, "the agent must follow at most 50 redirects");

  const notFound = await client.run("http.request", { url: `${httpBase}/status404` });
  assert.equal(notFound.result.status, 404, "a 404 must be a result");
  assert.equal(streamText(notFound.streams, "body"), "not here", "a 404 body must be streamed");

  const compressed = await client.run("http.request", { url: `${httpBase}/gzip` });
  assert.equal(streamText(compressed.streams, "body"), "decompressed text", "gzip responses must be decompressed");

  await expectCode(
    client.run("http.request", { url: `${httpBase}/slow`, timeoutMs: 250 }),
    "job.timeout",
    "http.request timeout",
  );

  await expectCode(
    client.run("http.request", { url: "not a url" }),
    "request.invalid",
    "http.request with an invalid URL",
  );

  await expectCode(
    client.run("http.request", { url: `${httpBase}/echo`, method: "BAD METHOD" }),
    "request.invalid",
    "http.request with an invalid method",
  );

  await expectCode(
    client.run("http.cookies.set", { cookies: [{ name: "x", value: "1", path: "bad" }] }),
    "request.invalid",
    "http.cookies.set with an invalid path",
  );

  const closedPort = await findClosedPort();
  await expectCode(
    client.run("http.request", { url: `http://127.0.0.1:${closedPort}/` }),
    "job.failed",
    "http.request to a closed port",
  );
}

async function testProtocolErrors() {
  section("protocol errors");

  await withClient(async (client) => {
    await expectCode(client.run("no.such.op", {}), "request.invalid", "unknown operation");
    await expectCode(client.run("fs.stat", {}), "request.invalid", "missing parameters");
    const stat = await client.run("fs.stat", { path: work, ignored: true });
    assert.equal(stat.result.type, "dir", "the connection must remain usable after request.invalid");
  });

  const cases = [
    {
      name: "invalid JSON",
      closeCode: 1002,
      async send(client) {
        client.socket.send("{");
      },
    },
    {
      name: "binary without a chunk header",
      closeCode: 1002,
      async send(client) {
        client.sendBinary(Buffer.from([1, 2, 3]));
      },
    },
    {
      name: "text between a chunk header and its binary",
      closeCode: 1002,
      async send(client) {
        client.sendJson({ type: "chunk", last: false });
        client.sendJson({ type: "cancel" });
      },
    },
    {
      name: "invalid chunk.last",
      closeCode: 1002,
      async send(client) {
        client.sendJson({ type: "chunk", last: "yes" });
      },
    },
    {
      name: "a request while a job is in flight",
      closeCode: 1002,
      async send(client) {
        client.sendRequest("exec.run", {
          file: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
        });
        client.sendInput([]);
        client.sendRequest("fs.stat", { path: work });
      },
    },
    {
      name: "an oversized Text message",
      closeCode: 1009,
      async send(client) {
        client.socket.send("x".repeat(1024 * 1024 + 16));
      },
    },
  ];

  for (const item of cases) {
    const client = await openRaw();
    try {
      await item.send(client);
      const close = await client.waitClosed();
      assert.equal(close.code, item.closeCode, `${item.name}: close code`);
    } finally {
      client.close();
    }
  }

  await withClient(async (client) => {
    client.sendJson({ type: "cancel" });
    client.sendChunk(false, Buffer.from("late"));
    client.sendChunk(true, Buffer.from("later"));
    const stat = await client.run("fs.stat", { path: work });
    assert.equal(stat.result.type, "dir", "idle cancel and late chunks must be ignored");
  });

  await withClient(async (client) => {
    client.sendRequest("exec.run", {
      file: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    });
    client.sendChunk(false, Buffer.from("partial input"));
    await sleep(100);
    client.sendJson({ type: "cancel" });
    await expectCode(client.readJob(), "job.cancelled", "cancel while ingesting");
  });
}

// Runs without card hardware: checks the shape of card.list, request validation,
// and the not-found mapping for an absent device.
async function testCard() {
  section("card");

  await withClient(async (client) => {
    const list = await client.run("card.list", {});
    assert.ok(Array.isArray(list.result.devices), "card.list must return a devices array");
    assert.equal(list.streams.size, 0, "card.list must have no output streams");

    for (const device of list.result.devices) {
      for (const field of ["name", "deviceId", "certificateId"]) {
        assert.equal(typeof device[field], "string", `device.${field} must be a string`);
        assert.ok(device[field].length > 0, `device.${field} must not be empty`);
      }
    }
  });

  await withClient(async (client) => {
    const invalid = [
      {},
      { device: "PCSC no-such-card", deviceId: "1" },
      { device: "PCSC no-such-card", pin: "12345678" },
      { device: "", deviceId: "1", pin: "12345678" },
      { device: "PCSC no-such-card", deviceId: "", pin: "12345678" },
      { device: "PCSC no-such-card", deviceId: "1", pin: "1234567" },
      { device: "PCSC no-such-card", deviceId: "1", pin: "123456789" },
      { device: "PCSC no-such-card", deviceId: "1", pin: "pässwörd" },
    ];

    for (const params of invalid) {
      await expectCode(client.run("card.verify", params), "request.invalid", "card.verify validation");
      await expectCode(client.run("card.sign", params), "request.invalid", "card.sign validation");
    }

    const absent = { device: "PCSC no-such-card", deviceId: "1", pin: "12345678" };
    await expectCode(client.run("card.verify", absent), "card.notFound", "verify on an absent card");
    await expectCode(
      client.run("card.sign", absent, [Buffer.from("message")]),
      "card.notFound",
      "sign on an absent card",
    );

    const stat = await client.run("fs.stat", { path: work });
    assert.equal(stat.result.type, "dir", "the connection must remain usable after card errors");
  });
}

async function testSecondInstance() {
  section("startup");

  const exit = await new Promise((resolve) => {
    const child = spawn(binaryPath, [], { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, timeout: true });
    }, 10_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timeout: false });
    });
  });

  assert.equal(exit.timeout, false, "a second instance must exit on its own");
  assert.equal(exit.code, 0, "a second instance must exit with code 0");
}

async function testSdk() {
  section("sdk");

  const bundlePath = path.join(root, "docs", "dist", "eport-runtime.iife.min.js");
  const bundle = await fs.readFile(bundlePath, "utf8");
  vm.runInThisContext(bundle, { filename: "eport-runtime.iife.min.js" });

  const { connect, AgentError, ConnectionClosedError } = globalThis.EportRuntime;
  assert.equal(typeof connect, "function", "the bundle must expose connect()");

  await assert.rejects(
    connect({ url: "ws://127.0.0.1:1/", timeoutMs: 1000 }),
    (error) => error instanceof ConnectionClosedError,
    "connect() must reject when the agent is unreachable",
  );

  sdk = await connect();
  const sdkPath = path.join(work, "sdk.txt");

  const write = await sdk.fs.write({ path: sdkPath }, { input: Buffer.from("sdk content") });
  assert.equal(write.size, 11, "sdk fs.write must report the size");
  assert.equal(await fs.readFile(sdkPath, "utf8"), "sdk content");

  const chunks = [];
  const read = await sdk.fs.read({ path: sdkPath }, { onChunk: (chunk) => chunks.push(chunk) });
  assert.equal(read.size, 11);
  assert.equal(Buffer.concat(chunks).toString("utf8"), "sdk content", "sdk fs.read must stream content");

  const stat = await sdk.fs.stat({ path: sdkPath });
  assert.equal(stat.type, "file", "sdk fs.stat must report a file");

  const entries = [];
  const list = await sdk.fs.list({ path: work }, { onEntry: (entry) => entries.push(entry) });
  assert.equal(list.count, entries.length, "sdk fs.list must call onEntry for every entry");
  assert.ok(entries.some((entry) => entry.name === "sdk.txt"), "sdk fs.list must parse entries");

  const blobPath = path.join(work, "blob.txt");
  await sdk.fs.write({ path: blobPath }, { input: new Blob(["blob input"]) });
  assert.equal(await fs.readFile(blobPath, "utf8"), "blob input", "sdk fs.write must accept a Blob");

  const streamPath = path.join(work, "stream.txt");
  const encoder = new TextEncoder();
  const input = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("stream-"));
      controller.enqueue(encoder.encode("input"));
      controller.close();
    },
  });
  await sdk.fs.write({ path: streamPath }, { input });
  assert.equal(await fs.readFile(streamPath, "utf8"), "stream-input", "sdk fs.write must accept a ReadableStream");

  const execOut = [];
  const execErr = [];
  const exec = await sdk.exec.run(
    {
      file: process.execPath,
      args: ["-e", "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{process.stdout.write('S:'+d);process.stderr.write('E')})"],
    },
    {
      input: Buffer.from("sdk stdin"),
      onStdout: (chunk) => execOut.push(chunk),
      onStderr: (chunk) => execErr.push(chunk),
    },
  );
  assert.equal(exec.exitCode, 0);
  assert.equal(Buffer.concat(execOut).toString("utf8"), "S:sdk stdin", "sdk exec.run must stream stdout");
  assert.equal(Buffer.concat(execErr).toString("utf8"), "E", "sdk exec.run must stream stderr");

  const httpBody = [];
  const httpResult = await sdk.http.request(
    { url: `${httpBase}/echo`, method: "POST" },
    { input: Buffer.from("sdk http"), onChunk: (chunk) => httpBody.push(chunk) },
  );
  assert.equal(httpResult.status, 200);
  assert.equal(Buffer.concat(httpBody).toString("utf8"), "sdk http", "sdk http.request must stream the body");

  const cookies = await sdk.http.cookies.set({
    cookies: [{ name: "sdk", value: "1", path: "/", secure: false, httpOnly: false }],
  });
  assert.deepEqual(cookies, {}, "sdk cookies.set must return an empty result");
  const cookieSnapshot = await sdk.http.cookies.get();
  assert.equal(cookieSnapshot.cookies.length, 1);
  assert.equal(cookieSnapshot.cookies[0].name, "sdk");

  const cards = await sdk.card.list();
  assert.ok(Array.isArray(cards.devices), "sdk card.list must return a devices array");
  await assert.rejects(
    sdk.card.verify({ device: "PCSC no-such-card", deviceId: "1", pin: "1234567" }),
    (error) => error.code === "request.invalid",
    "sdk card.verify must validate the PIN length",
  );

  const [parallelStat, parallelList, parallelExec] = await Promise.all([
    sdk.fs.stat({ path: sdkPath }),
    sdk.fs.list({ path: work }),
    sdk.exec.run({ file: process.execPath, args: ["-e", "process.stdout.write('parallel')"] }),
  ]);
  assert.equal(parallelStat.type, "file", "Promise.all must serialise SDK operations");
  assert.ok(parallelList.count > 0);
  assert.equal(parallelExec.exitCode, 0);

  await assert.rejects(
    sdk.fs.read({ path: sdkPath }, { onChunk: () => { throw new Error("callback exploded"); } }),
    /callback exploded/,
    "a throwing handler must reject the operation",
  );
  const afterThrow = await sdk.fs.stat({ path: sdkPath });
  assert.equal(afterThrow.type, "file", "the connection must survive a throwing handler");

  const badInputPath = path.join(work, "bad-input.txt");
  const badInput = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("partial"));
      controller.error(new Error("input exploded"));
    },
  });
  await assert.rejects(
    sdk.fs.write({ path: badInputPath }, { input: badInput }),
    /input exploded/,
    "a failing input stream must reject the operation",
  );
  await waitForMissing(badInputPath, "a failed fs.write");
  const afterInputError = await sdk.fs.stat({ path: sdkPath });
  assert.equal(afterInputError.type, "file", "the connection must survive a failing input stream");
  const strayParts = (await fs.readdir(work)).filter((name) => name.startsWith(".eport-"));
  assert.deepEqual(strayParts, [], "a failed fs.write must delete its .part file");

  await expectCode(
    sdk.exec.run({ file: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"], timeoutMs: 200 }),
    "job.timeout",
    "sdk timeout",
  );
  await expectCode(sdk.fs.stat({ path: path.join(work, "missing-sdk") }), "job.failed", "sdk job failure");

  try {
    await sdk.fs.stat({ path: path.join(work, "missing-sdk") });
    assert.fail("expected an AgentError");
  } catch (error) {
    assert.equal(error instanceof AgentError, true, "SDK errors must be AgentError instances");
    assert.equal(error.code, "job.failed");
  }

  await sdk.fs.delete({ path: sdkPath });
  await waitForMissing(sdkPath, "sdk fs.delete");

  sdk.close();
  await assert.rejects(sdk.fs.stat({ path: work }), (error) => error instanceof ConnectionClosedError);
  sdk = null;
}

async function cleanup() {
  if (rawAgent !== null) {
    rawAgent.close();
    rawAgent = null;
  }

  if (sdk !== null) {
    try {
      sdk.close();
    } catch {
    }

    sdk = null;
  }

  if (httpServer !== null) {
    if (typeof httpServer.closeAllConnections === "function") {
      httpServer.closeAllConnections();
    }

    await new Promise((resolve) => httpServer.close(resolve));
    httpServer = null;
  }

  if (agent !== null) {
    if (agent.exitCode === null) {
      try {
        agent.kill();
      } catch {
      }

      await Promise.race([
        new Promise((resolve) => agent.once("exit", resolve)),
        sleep(5000),
      ]);
    }

    agent = null;
  }

  if (work !== undefined) {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }

  if (linkRoot !== undefined) {
    await fs.rm(linkRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// The agent starts over a deliberately stale temp tree, proving the startup
// sweep. The final directory checks prove each job removed its own temp files.
async function main() {
  await testErrorCodes();
  binaryPath = await resolveBinary();
  const bundlePath = path.join(root, "docs", "dist", "eport-runtime.iife.min.js");
  await fs.access(bundlePath).catch(() => {
    throw new Error(`${bundlePath} is missing; run npm run build first`);
  });

  if (await tcpOpen()) {
    throw new Error(
      "another process is already listening on 127.0.0.1:26099; stop it before running the smoke test",
    );
  }

  work = await fs.mkdtemp(path.join(os.tmpdir(), "eport-smoke-"));
  const tempRoot = path.join(os.tmpdir(), "eport-runtime");
  const stale = path.join(tempRoot, "stale", "old.txt");
  await fs.mkdir(path.dirname(stale), { recursive: true });
  await fs.writeFile(stale, "stale");

  agent = spawn(binaryPath, [], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  agent.stderr.on("data", (data) => {
    agentStderr += data.toString();
  });
  agent.once("exit", (code, signal) => {
    agentExit = { code, signal };
  });

  await waitForPort();
  await testWindowsImage();
  await waitForMissing(stale, "the startup temp sweep");

  if (!isWindows) {
    const mode = (await fs.stat(tempRoot)).mode & 0o777;
    assert.equal(mode, 0o700, "the temp root must be private on Unix");
  }

  await testHandshake();
  rawAgent = await openRaw();

  await testFiles(rawAgent);
  await testSymlinks(rawAgent);
  await testExec(rawAgent);
  await startHttpServer();
  await testHttp(rawAgent);
  await waitForEmptyDirectory(tempRoot, "the job temp directory after the raw tests");
  rawAgent.close();
  rawAgent = null;

  await testProtocolErrors();
  await testCard();
  await testSecondInstance();
  await waitForEmptyDirectory(tempRoot, "the job temp directory after the protocol tests");

  await testSdk();
  await waitForEmptyDirectory(tempRoot, "the job temp directory after the SDK tests");

  const leftovers = (await fs.readdir(work)).filter((name) => name.startsWith(".eport-"));
  assert.deepEqual(leftovers, [], "no fs.write temp file may remain");

  console.log("\nsmoke test passed");
}

try {
  await Promise.race([
    main(),
    sleep(180_000).then(() => {
      throw new Error("the smoke test timed out after 180 seconds");
    }),
  ]);
  process.exitCode = 0;
} catch (error) {
  console.error("\nsmoke test failed");
  console.error(error instanceof Error ? error.stack : String(error));
  if (agentStderr.length > 0) {
    console.error("\nagent stderr:\n" + agentStderr);
  }

  process.exitCode = 1;
} finally {
  await cleanup();
  process.exit(process.exitCode ?? 1);
}
