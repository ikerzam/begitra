#!/usr/bin/env node
// Cuts a Windows release of Begitra: checks that the three manifests agree on the version and that
// site/releases.json describes it, builds the NSIS and MSI bundles with the updater's key, stages
// the site the server holds in src-tauri/target/release-site (the versioned folder, the pages and
// their assets, latest.json) and, with --upload, copies it there, `latest.json` last so the
// manifest never names a file the server lacks. --site-only stages and
// uploads the pages without building or touching the installers and latest.json, once the
// server's installers of the version match the local ones.
//
//   node scripts/release.mjs [--notes <text>] [--skip-build] [--site-only]
//                            [--upload <user@host:/path>] [--identity <key file>]

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  agreedVersion,
  findInstallers,
  hashedName,
  ICONS,
  LANGUAGES,
  loadIcons,
  minisignature,
  readVersions,
  releaseOf,
  siteBase,
  sitePages,
  updateManifest,
  updaterKey,
} from "./release-site.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const modules = join(root, "node_modules");

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { notes: null, skipBuild: false, siteOnly: false, upload: null, identity: null };
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
    else if (argument === "--site-only") options.siteOnly = true;
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

function readJson(...path) {
  return JSON.parse(readFileSync(join(root, ...path), "utf8"));
}

/**
 * The site's assets under content-hashed names, since the server caches them as immutable: the
 * images of site/assets, the fonts the app bundles and the stylesheet pointing at them.
 * Returns each asset's hashed name.
 */
function stageAssets(site) {
  const dir = join(site, "assets");
  mkdirSync(dir, { recursive: true });
  const assets = {};
  const put = (name, content) => {
    const hashed = hashedName(name, content);
    writeFileSync(join(dir, hashed), content);
    assets[name] = hashed;
  };
  const images = join(root, "site", "assets");
  for (const name of readdirSync(images)) put(name, readFileSync(join(images, name)));
  const fonts = {
    "geist.woff2": join(
      modules,
      "@fontsource-variable",
      "geist",
      "files",
      "geist-latin-wght-normal.woff2",
    ),
    "geist-mono.woff2": join(
      modules,
      "@fontsource-variable",
      "geist-mono",
      "files",
      "geist-mono-latin-wght-normal.woff2",
    ),
  };
  for (const [name, path] of Object.entries(fonts)) put(name, readFileSync(path));
  let css = readFileSync(join(root, "site", "site.css"), "utf8");
  for (const name of Object.keys(fonts)) {
    if (!css.includes(`url("${name}")`)) fail(`site/site.css does not load ${name}`);
    css = css.replaceAll(`url("${name}")`, `url("${assets[name]}")`);
  }
  put("site.css", css);
  return assets;
}

/** The notices the fonts' and the icons' licenses ask to travel with them. */
function licenses() {
  const license = (...path) => readFileSync(join(modules, ...path, "LICENSE"), "utf8").trim();
  return [
    "Begitra's site serves these third-party works.",
    "",
    "Geist (the interface font), under the SIL Open Font License 1.1:",
    "",
    license("@fontsource-variable", "geist"),
    "",
    "Geist Mono (the code font), under the SIL Open Font License 1.1:",
    "",
    license("@fontsource-variable", "geist-mono"),
    "",
    "Lucide (the icons), under the ISC License:",
    "",
    license("@lucide", "vue"),
    "",
  ].join("\n");
}

function destinationOf(destination) {
  // The remote path reaches a shell on the server (`mkdir -p`, `sha256sum`): plain characters only.
  const match = /^([^@:\s]+@[^:\s]+):(\/[A-Za-z0-9._/-]*)$/.exec(destination);
  if (!match) {
    fail(`--upload takes user@host:/absolute/path with letters, digits and . _ / - in the path`);
  }
  return { host: match[1], remote: match[2].replace(/\/+$/, "") };
}

/**
 * Stops a site-only upload when an installer the pages describe is not, byte for byte, the one
 * the server holds: a rebuilt local installer would put a wrong SHA-256 on the download page.
 */
function checkServerInstallers(host, key, remote, version, installers) {
  const paths = installers.map((installer) => {
    if (!/^[A-Za-z0-9._-]+$/.test(installer.name))
      fail(`unexpected installer name ${installer.name}`);
    return `${remote}/releases/v${version}/${installer.name}`;
  });
  console.log(`> ssh ${host} sha256sum ${paths.join(" ")}`);
  const result = spawnSync("ssh", [...key, host, "sha256sum", ...paths], { encoding: "utf8" });
  if (result.status !== 0) {
    fail(`the server's installers of ${version} could not be read: ${result.stderr.trim()}`);
  }
  const served = new Map(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [hash, path] = line.trim().split(/\s+/);
        return [path.slice(path.lastIndexOf("/") + 1), hash];
      }),
  );
  for (const installer of installers) {
    if (served.get(installer.name) !== installer.sha256) {
      fail(
        `${installer.name} on the server is not the local one (${served.get(installer.name) ?? "missing"} against ${installer.sha256}): the pages would show the wrong checksum`,
      );
    }
  }
  console.log(`the server's installers of ${version} match the local ones`);
}

function upload(site, version, installers, { destination, identity, siteOnly }) {
  const { host, remote } = destinationOf(destination);
  const key = identity ? ["-i", identity] : [];
  // Relative local paths: an `scp` argument that starts with a drive letter reads as a host.
  const scp = (...args) => run("scp", [...key, ...args], { cwd: site });
  if (siteOnly) checkServerInstallers(host, key, remote, version, installers);
  run("ssh", [...key, host, "mkdir", "-p", `${remote}/releases/v${version}`]);
  if (siteOnly) {
    const signatures = installers.map(
      (installer) => `releases/v${version}/${installer.name}.minisig`,
    );
    scp(...signatures, `${host}:${remote}/releases/v${version}/`);
  } else {
    scp("-r", `releases/v${version}`, `${host}:${remote}/releases/`);
  }
  // The assets before the pages that name them, the pages before latest.json.
  scp("-r", "assets", `${host}:${remote}/`);
  const folders = readdirSync(site, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !["assets", "releases"].includes(entry.name))
    .map((entry) => entry.name);
  scp("-r", ...folders, `${host}:${remote}/`);
  scp(
    "favicon.ico",
    "licenses.txt",
    "robots.txt",
    "sitemap.xml",
    "index.html",
    `${host}:${remote}/`,
  );
  if (!siteOnly) scp("latest.json", `${host}:${remote}/latest.json`);
  console.log(`uploaded ${siteOnly ? "the site of " : ""}v${version} to ${host}:${remote}`);
}

const options = parseArgs(process.argv.slice(2));
if (process.platform !== "win32") fail("a release is built on Windows");
let version;
let base;
let key;
let release;
let releases;
try {
  version = agreedVersion(readVersions(root));
  const config = readJson("src-tauri", "tauri.conf.json");
  base = siteBase(config.plugins?.updater?.endpoints?.[0] ?? "");
  key = updaterKey(config.plugins?.updater?.pubkey ?? "");
  releases = readJson("site", "releases.json");
  release = releaseOf(releases, version);
} catch (error) {
  fail(error.message);
}

if (!options.skipBuild && !options.siteOnly) {
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
  if (!options.siteOnly) {
    copyFileSync(installer.path, join(folder, installer.name));
    copyFileSync(`${installer.path}.sig`, join(folder, `${installer.name}.sig`));
  }
  writeFileSync(join(folder, `${installer.name}.minisig`), minisignature(installer.signature));
}

const assets = stageAssets(site);
const pages = sitePages({
  version,
  release,
  releases,
  installers,
  key,
  base,
  strings: Object.fromEntries(
    LANGUAGES.map((lang) => [lang, readJson("site", "strings", `${lang}.json`)]),
  ),
  site: readJson("site", "site.json"),
  assets,
  images: readJson("site", "images.json"),
  icons: loadIcons(join(modules, "@lucide", "vue", "dist", "esm", "icons"), ICONS),
});
for (const [path, content] of Object.entries(pages)) {
  mkdirSync(dirname(join(site, path)), { recursive: true });
  writeFileSync(join(site, path), content);
}
copyFileSync(join(root, "site", "assets", "favicon.ico"), join(site, "favicon.ico"));
writeFileSync(join(site, "licenses.txt"), licenses());

if (!options.siteOnly) {
  const notes = options.notes ?? release.notes.en;
  const manifest = updateManifest({ version, date: new Date(), notes, base, installers });
  writeFileSync(join(site, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
console.log(`staged ${options.siteOnly ? "the site of " : ""}v${version} in ${site} for ${base}`);

if (options.upload) {
  upload(site, version, installers, {
    destination: options.upload,
    identity: options.identity,
    siteOnly: options.siteOnly,
  });
} else if (options.siteOnly) {
  console.log("not uploaded: the local installers were not compared with the server's");
}
