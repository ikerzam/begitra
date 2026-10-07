#!/usr/bin/env node
// Builds the agent server, `begitra-mcp`, in release and places it where Tauri's sidecar
// bundling looks for it: `src-tauri/binaries/begitra-mcp-<target triple>[.exe]`. The
// `tauri.agent.conf.json` layer runs it before a build and names that file in `externalBin`, so
// the installers carry the server beside the app; a build without the layer needs nothing here,
// because `tauri-build` checks every `externalBin` whenever the app crate builds.
//
//   node scripts/build-agent-server.mjs
//
// The target is the one Tauri builds for (`TAURI_ENV_TARGET_TRIPLE`, which it sets for the
// commands it runs before a build), else the host's.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const tauri = fileURLToPath(new URL("../src-tauri", import.meta.url));

function fail(message) {
  console.error(`build-agent-server: ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: tauri,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed (${result.status ?? result.error?.message})`);
  }
  return result.stdout;
}

const host = /^host: (\S+)$/m.exec(run("rustc", ["-vV"]))?.[1];
if (!host) fail("rustc -vV named no host triple");
const triple = process.env.TAURI_ENV_TARGET_TRIPLE || host;
const cross = triple !== host;
const exe = triple.includes("windows") ? ".exe" : "";

run("cargo", [
  "build",
  "--release",
  "--package",
  "begitra-mcp",
  ...(cross ? ["--target", triple] : []),
]);
const built = join(tauri, "target", ...(cross ? [triple] : []), "release", `begitra-mcp${exe}`);
const binaries = join(tauri, "binaries");
mkdirSync(binaries, { recursive: true });
copyFileSync(built, join(binaries, `begitra-mcp-${triple}${exe}`));
console.log(`build-agent-server: begitra-mcp for ${triple} in src-tauri/binaries`);
