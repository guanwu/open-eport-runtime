// Copyright (C) 2026 Jiaowei <wei.jiao@guanwu.com>
// SPDX-License-Identifier: AGPL-3.0-only

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const docs = join(root, "docs");
const dist = join(docs, "dist");
const staging = join(root, ".build", "docs-dist");
const previous = join(root, ".build", "docs-dist.previous");
const entry = join(root, "src", "EportRuntimeSdk", "index.ts");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const shared = {
  entryPoints: [entry],
  bundle: true,
  platform: "browser",
  target: ["es2020"],
  legalComments: "none",
  sourcemap: true,
  logLevel: "info",
};

await build({
  ...shared,
  format: "iife",
  globalName: "EportRuntime",
  outfile: join(staging, "eport-runtime.iife.js"),
});

await build({
  ...shared,
  format: "iife",
  globalName: "EportRuntime",
  minify: true,
  outfile: join(staging, "eport-runtime.iife.min.js"),
});

await build({
  ...shared,
  format: "esm",
  outfile: join(staging, "eport-runtime.esm.js"),
});

await build({
  ...shared,
  format: "esm",
  minify: true,
  outfile: join(staging, "eport-runtime.esm.min.js"),
});

execFileSync(
  process.execPath,
  [tsc, "-p", join(root, "tsconfig.build.json"), "--outDir", staging],
  { stdio: "inherit" },
);

writeFileSync(
  join(staging, "package.json"),
  `${JSON.stringify(
    {
      type: "module",
      sideEffects: false,
      author: "Jiaowei <wei.jiao@guanwu.com>",
      license: "AGPL-3.0-only",
    },
    null,
    2,
  )}\n`,
);

// Swap the finished staging tree into docs/dist. If the swap fails, put the
// previous bundle back so a broken build never removes the working one.
rmSync(previous, { recursive: true, force: true });
if (existsSync(dist)) {
  renameSync(dist, previous);
}

try {
  renameSync(staging, dist);
} catch (error) {
  if (existsSync(previous)) {
    renameSync(previous, dist);
  }
  throw error;
}

rmSync(previous, { recursive: true, force: true });

// docs/ is the published site root, so the documents linked from index.html
// must live beside it.
for (const name of ["README.md", "DESIGN.md", "PROTOCOL.md"]) {
  copyFileSync(join(root, name), join(docs, name));
}

console.log("build done: docs/dist/eport-runtime.[iife|esm][.min].js (+ .map) + docs/dist/*.d.ts + docs/*.md");
