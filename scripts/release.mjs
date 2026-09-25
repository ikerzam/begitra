#!/usr/bin/env node
// Cuts a Windows release of Begitra: checks that the three manifests agree on
// the version, builds the NSIS and MSI bundles with the updater's key, stages the site the server
// holds in src-tauri/target/release-site and, with --upload, copies it there, `latest.json` last
// so the manifest never names a file the server lacks.
//
//   node scripts/release.mjs [--notes <text>] [--skip-build] [--upload <user@host:/path>] [--identity <key file>]

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  agreedVersion,
  downloadPage,
  findInstallers,
  readVersions,
  siteBase,
  updateManifest,
} from "./release-site.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { notes: null, skipBuild: false, upload: null, identity: null };
  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at];
    const value = () => {
      at += 1;
      const next = argv[at];
      if (next === undefined) fail(`${argument} needs a value`);
      return next;
    };
    if (argument === "--notes") options.notes = value();
    else if (argument === "--skip-build") options.skipBuild = true;
    else if (argument === "--upload") options.upload = value();
    else if (argument === "--identity") options.identity = value();
    else fail(`unknown argument ${argument}`);
  }
  return options;
}

/**
 * Runs a command with its own argument list. `pnpm` is a `.cmd` on Windows, which only
 * `cmd.exe` starts: it gets this script's fixed arguments, never text from outside.
 */
function run(command, args, { env = process.env, cwd = root } = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const viaCmd = process.platform === "win32" && command === "pnpm";
  const [program, argv] = viaCmd
    ? [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command, ...args]]
    : [command, args];
  const result = spawnSync(program, argv, { cwd, env, stdio: "inherit" });
  if (result.status !== 0) {
    fail(`${command} ended with ${result.status ?? result.signal ?? result.error?.message}`);
  }
}

/** The updater's key: the environment's, else `~/.tauri/begitra.key` without a password. */
function signingEnv() {
  const env = { ...process.env };
  if (!env.TAURI_SIGNING_PRIVATE_KEY) {
    const key = join(homedir(), ".tauri", "begitra.key");
    if (!existsSync(key)) {
      fail(`no updater key: set TAURI_SIGNING_PRIVATE_KEY or create ${key}`);
    }
    env.TAURI_SIGNING_PRIVATE_KEY = key;
  }
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
  return env;
}

function upload(site, version, destination, identity) {
  // The remote path reaches a shell on the server (`mkdir -p`): only plain characters pass.
  const match = /^([^@:\s]+@[^:\s]+):(\/[A-Za-z0-9._/-]*)$/.exec(destination);
  if (!match) {
    fail(`--upload takes user@host:/absolute/path with letters, digits and . _ / - in the path`);
  }
  const [, host, path] = match;
  const remote = path.replace(/\/+$/, "");
  const key = identity ? ["-i", identity] : [];
  // Relative local paths: an `scp` argument that starts with a drive letter reads as a host.
  run("ssh", [...key, host, "mkdir", "-p", `${remote}/releases`]);
  run("scp", [...key, "-r", `releases/v${version}`, `${host}:${remote}/releases/`], { cwd: site });
  run("scp", [...key, "index.html", `${host}:${remote}/index.html`], { cwd: site });
  run("scp", [...key, "latest.json", `${host}:${remote}/latest.json`], { cwd: site });
  console.log(`uploaded v${version} to ${host}:${remote}`);
}

const options = parseArgs(process.argv.slice(2));
if (process.platform !== "win32") fail("a release is built on Windows");
let version;
let base;
try {
  version = agreedVersion(readVersions(root));
  const config = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  base = siteBase(config.plugins?.updater?.endpoints?.[0] ?? "");
} catch (error) {
  fail(error.message);
}

if (!options.skipBuild) {
  run("pnpm", ["tauri", "build", "--bundles", "nsis", "msi"], { env: signingEnv() });
}

let installers;
try {
  installers = findInstallers(join(root, "src-tauri", "target", "release", "bundle"), version);
} catch (error) {
  fail(error.message);
}

const site = join(root, "src-tauri", "target", "release-site");
// A scanner may still hold the installers the last run copied: removal retries a moment later.
rmSync(site, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
const folder = join(site, "releases", `v${version}`);
mkdirSync(folder, { recursive: true });
for (const installer of installers) {
  copyFileSync(installer.path, join(folder, installer.name));
  copyFileSync(`${installer.path}.sig`, join(folder, `${installer.name}.sig`));
}
const date = new Date();
const notes = options.notes ?? `Begitra ${version}`;
const manifest = updateManifest({ version, date, notes, base, installers });
writeFileSync(join(site, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(site, "index.html"), downloadPage({ version, date, installers }));
console.log(`staged v${version} in ${site} for ${base}`);

if (options.upload) upload(site, version, options.upload, options.identity);
