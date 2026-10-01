#!/usr/bin/env node
// Checks, signs and stages a Windows release of Begitra. The release workflow runs it when a tag
// `v<version>` is pushed, and so can any machine holding the updater's key. The notes of a version
// are its entry in the site repository's releases.json.
//
//   node scripts/release.mjs check --releases <releases.json> [--tag v<version>]
//       the three manifests agree, the tag names their version, releases.json describes it
//   node scripts/release.mjs sign --installers <bundle folder>
//       signs the version's NSIS and MSI installers with the updater's key: the key itself in
//       TAURI_SIGNING_PRIVATE_KEY when set, else the file ~/.tauri/begitra.key
//   node scripts/release.mjs stage --releases <releases.json> --installers <bundle folder> --out <folder>
//       verifies each signature against the public key the app trusts, then writes what the
//       release publishes (<out>/assets/) and its body (<out>/notes.md)
//
// The bundle folder is the one `tauri build` leaves (`src-tauri/target/release/bundle`) or a copy
// keeping its `nsis/` and `msi/` folders.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  agreedVersion,
  checkTag,
  installerFiles,
  readVersions,
  releaseOf,
  stageRelease,
} from "./release-files.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

const OPTIONS = {
  check: { allowed: ["releases", "tag"], required: ["releases"] },
  sign: { allowed: ["installers"], required: ["installers"] },
  stage: {
    allowed: ["releases", "installers", "out"],
    required: ["releases", "installers", "out"],
  },
};

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const spec = OPTIONS[command];
  if (!spec) fail("usage: node scripts/release.mjs check|sign|stage, as its header describes");
  const options = {};
  for (let at = 0; at < rest.length; at += 2) {
    const flag = rest[at];
    const name = flag.startsWith("--") ? flag.slice(2) : "";
    if (!spec.allowed.includes(name)) fail(`${command} does not take ${flag}`);
    if (rest[at + 1] === undefined) fail(`${flag} needs a value`);
    options[name] = rest[at + 1];
  }
  for (const name of spec.required) {
    if (!options[name]) fail(`${command} needs --${name}`);
  }
  return { command, options };
}

function readReleases(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return fail(`${path} could not be read as releases.json: ${error.message}`);
  }
}

/**
 * The environment `tauri signer sign` takes the key from: the key itself when the environment
 * holds it (the workflow's secret), else the path of the key file.
 */
function signingEnv() {
  const env = { ...process.env };
  if (env.TAURI_SIGNING_PRIVATE_KEY) {
    delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
  } else {
    const key = join(homedir(), ".tauri", "begitra.key");
    if (!existsSync(key)) {
      fail(`no updater key: set TAURI_SIGNING_PRIVATE_KEY to the key, or create ${key}`);
    }
    delete env.TAURI_SIGNING_PRIVATE_KEY;
    env.TAURI_SIGNING_PRIVATE_KEY_PATH = key;
  }
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= "";
  return env;
}

/**
 * Signs each installer with the Tauri CLI's signer, started through Node with its own argument
 * list. Its standard output (the signature, which the `.sig` file holds too) is not printed.
 */
function sign(bundleDir, version) {
  const env = signingEnv();
  const cli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
  for (const installer of installerFiles(bundleDir, version)) {
    const result = spawnSync(process.execPath, [cli, "signer", "sign", installer.path], {
      cwd: root,
      env,
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (result.status !== 0 || !existsSync(`${installer.path}.sig`)) {
      fail(`signing ${installer.name} failed (${result.status ?? result.error?.message})`);
    }
    console.log(`signed ${installer.name}`);
  }
}

const { command, options } = parseArgs(process.argv.slice(2));
try {
  if (command === "check") {
    const version = agreedVersion(readVersions(root));
    if (options.tag !== undefined) checkTag(version, options.tag);
    releaseOf(readReleases(options.releases), version);
    console.log(
      `${version}: the manifests agree${options.tag ? `, ${options.tag} names it` : ""}, and releases.json describes it`,
    );
  } else if (command === "sign") {
    sign(options.installers, agreedVersion(readVersions(root)));
  } else {
    const staged = stageRelease({
      root,
      releases: readReleases(options.releases),
      installers: options.installers,
      out: options.out,
      date: new Date(),
    });
    console.log(`staged ${staged.version} in ${options.out}: ${staged.assets.join(", ")}`);
  }
} catch (error) {
  fail(error.message);
}
