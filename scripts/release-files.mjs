// What a release publishes, and the checks it passes first: the version the three manifests and
// the tag agree on, the installers a build left, their updater signatures checked against the key
// the app trusts, the update manifest, the facts the site's pages read and the release's body.
// Used by scripts/release.mjs and tested in tests/release.test.ts.

import { createHash, createPublicKey, verify } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** The languages each release's title and notes are written in. */
export const LANGUAGES = ["en", "es"];

/** The version each manifest declares: `package.json`, the Cargo workspace, `tauri.conf.json`. */
export function readVersions(root) {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const tauri = JSON.parse(
    readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"),
  ).version;
  const cargoToml = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
  const section = cargoToml.split(/^\[workspace\.package\]\s*$/m)[1] ?? "";
  const cargo = /^version\s*=\s*"([^"]+)"/m.exec(section.split(/^\[/m)[0] ?? "")?.[1] ?? null;
  return {
    "package.json": packageJson ?? null,
    "src-tauri/Cargo.toml": cargo,
    "tauri.conf.json": tauri ?? null,
  };
}

/** The one version the manifests agree on; throws naming each when they differ or one is missing. */
export function agreedVersion(versions) {
  const values = Object.values(versions);
  const first = values[0];
  if (!first || values.some((value) => value !== first)) {
    const listed = Object.entries(versions)
      .map(([file, value]) => `${file}: ${value ?? "none"}`)
      .join(", ");
    throw new Error(`the versions differ or one is missing (${listed})`);
  }
  return first;
}

/** Throws unless the tag is `v` and the version: a tag publishes the version it names. */
export function checkTag(version, tag) {
  if (tag !== `v${version}`) {
    throw new Error(`the tag ${tag} does not name ${version}, the version the manifests agree on`);
  }
}

const LATEST_MANIFEST =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases\/latest\/download\/latest\.json$/;

/**
 * The GitHub repository a release is published to and the address its files download from, read
 * from the updater's first endpoint, the repository's latest `latest.json`: the app asks there
 * first, so the app and its releases cannot disagree on where they live.
 */
export function releaseDownloads(endpoints) {
  const match = LATEST_MANIFEST.exec(endpoints[0] ?? "");
  if (!match) {
    throw new Error(
      `the updater's first endpoint must be the latest GitHub release's manifest, https://github.com/<owner>/<repository>/releases/latest/download/latest.json, not ${endpoints[0] ?? "nothing"}`,
    );
  }
  const repository = `${match[1]}/${match[2]}`;
  return { repository, downloads: `https://github.com/${repository}/releases/download/` };
}

/**
 * The NSIS and MSI installers of `version` under `bundleDir`, in the bundle's `nsis/` and `msi/`
 * folders: `{ kind, name, path }`. Throws unless there is exactly one of each, since a release
 * without both is not one to publish.
 */
export function installerFiles(bundleDir, version) {
  const kinds = [
    { kind: "nsis", folder: "nsis", suffix: "-setup.exe" },
    { kind: "msi", folder: "msi", suffix: ".msi" },
  ];
  return kinds.map(({ kind, folder, suffix }) => {
    const dir = join(bundleDir, folder);
    const names = existsSync(dir)
      ? readdirSync(dir).filter((name) => name.endsWith(suffix) && name.includes(`_${version}_`))
      : [];
    if (names.length !== 1) {
      throw new Error(
        `expected one ${kind} installer of ${version} in ${dir}, found ${names.length}`,
      );
    }
    return { kind, name: names[0], path: join(dir, names[0]) };
  });
}

/**
 * The installers of `version` (see `installerFiles`), each with its updater signature and its
 * SHA-256: `{ kind, name, path, size, sha256, signature }`. Throws when one is unsigned.
 */
export function findInstallers(bundleDir, version) {
  return installerFiles(bundleDir, version).map(({ kind, name, path }) => {
    let signature;
    try {
      signature = readFileSync(`${path}.sig`, "utf8").trim();
    } catch {
      throw new Error(`${name} has no updater signature (${name}.sig): sign it first`);
    }
    const bytes = readFileSync(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { kind, name, path, size: bytes.length, sha256, signature };
  });
}

/** A key id as minisign prints it: the 8 bytes from last to first, in upper-case hex. */
function keyIdText(bytes) {
  return Buffer.from(bytes).reverse().toString("hex").toUpperCase();
}

/**
 * The bytes of `plugins.updater.pubkey`: the base64 of a minisign public key file, whose second
 * line holds "Ed", the key id (8 bytes) and the Ed25519 key (32 bytes).
 */
function publicKeyBytes(pubkey) {
  const text = Buffer.from(pubkey, "base64").toString("utf8");
  const raw = Buffer.from(text.split(/\r?\n/)[1]?.trim() ?? "", "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new Error("plugins.updater.pubkey is not a minisign public key");
  }
  return { raw, id: raw.subarray(2, 10), key: raw.subarray(10) };
}

/** The updater's public key as minisign takes it (`-P`), and its key id. */
export function updaterKey(pubkey) {
  const { raw, id } = publicKeyBytes(pubkey);
  return { key: raw.toString("base64"), id: keyIdText(id) };
}

/**
 * The parts of the minisign signature file an updater signature is the base64 of: the algorithm,
 * the key id and the signature (one line), the trusted comment, and the global signature over the
 * signature and that comment.
 */
function signatureParts(signature) {
  const lines = Buffer.from(signature, "base64").toString("utf8").split(/\r?\n/);
  const prefix = "trusted comment: ";
  const bytes = Buffer.from(lines[1] ?? "", "base64");
  const global = Buffer.from(lines[3] ?? "", "base64");
  if (
    !lines[0]?.startsWith("untrusted comment:") ||
    !lines[2]?.startsWith(prefix) ||
    bytes.length !== 74 ||
    global.length !== 64
  ) {
    throw new Error("the updater signature is not a minisign signature");
  }
  return {
    algorithm: bytes.subarray(0, 2).toString("latin1"),
    keyId: bytes.subarray(2, 10),
    signature: bytes.subarray(10),
    comment: lines[2].slice(prefix.length),
    global,
  };
}

/**
 * Throws unless `signature` (an updater signature, as `tauri signer sign` writes it) signs
 * `bytes` with the key `pubkey` names: the same key id, the Ed25519 signature of the file's
 * BLAKE2b-512, and the global signature over that signature and the trusted comment. Only the
 * prehashed form ("ED") is taken, the one Tauri writes.
 */
export function verifySignature(bytes, signature, pubkey) {
  const parts = signatureParts(signature);
  if (parts.algorithm !== "ED") {
    throw new Error(
      `the signature's algorithm is "${parts.algorithm}", not the prehashed "ED" Tauri writes`,
    );
  }
  const { id, key } = publicKeyBytes(pubkey);
  if (!parts.keyId.equals(id)) {
    throw new Error(
      `signed by the key ${keyIdText(parts.keyId)}, and the app trusts ${keyIdText(id)}`,
    );
  }
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") },
    format: "jwk",
  });
  const digest = createHash("blake2b512").update(bytes).digest();
  if (!verify(null, digest, publicKey, parts.signature)) {
    throw new Error("the signature does not match the file");
  }
  const signed = Buffer.concat([parts.signature, Buffer.from(parts.comment, "utf8")]);
  if (!verify(null, signed, publicKey, parts.global)) {
    throw new Error(`the trusted comment is not the one signed ("${parts.comment}")`);
  }
}

/** The minisign signature file a Tauri updater signature holds: what `minisign -V` reads. */
export function minisignature(signature) {
  const text = Buffer.from(signature, "base64").toString("utf8");
  if (!text.startsWith("untrusted comment:") || !text.includes("\ntrusted comment:")) {
    throw new Error("the updater signature is not a minisign signature");
  }
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * `latest.json` as the updater reads it: the version, its date, its notes and, per installer, the
 * file's URL on the release and its signature. `windows-x86_64` is the NSIS installer, as
 * `tauri-action` writes it with `updaterJsonPreferNsis`; a copy installed from the MSI finds its
 * own entry first.
 */
export function updateManifest({ version, date, notes, downloads, installers }) {
  const url = (installer) => new URL(`v${version}/${installer.name}`, downloads).toString();
  const entry = (installer) => ({ signature: installer.signature, url: url(installer) });
  const byKind = Object.fromEntries(installers.map((installer) => [installer.kind, installer]));
  if (!byKind.nsis || !byKind.msi) {
    throw new Error("a release needs the NSIS and the MSI installers");
  }
  return {
    version,
    notes,
    pub_date: date.toISOString().replace(/\.\d{3}Z$/, "Z"),
    platforms: {
      "windows-x86_64": entry(byKind.nsis),
      "windows-x86_64-nsis": entry(byKind.nsis),
      "windows-x86_64-msi": entry(byKind.msi),
    },
  };
}

/**
 * `site-facts.json`, what the site's pages say about the release: its version, the updater's
 * public key and its id, and each installer's kind, name, size and SHA-256.
 */
export function siteFacts({ version, key, installers }) {
  return {
    version,
    key,
    installers: installers.map(({ kind, name, size, sha256 }) => ({ kind, name, size, sha256 })),
  };
}

/** The entry of `version` in the site's `releases.json`; throws when the version has none. */
export function releaseOf(releases, version) {
  const release = releases.find((entry) => entry.version === version);
  if (!release) {
    throw new Error(
      `releases.json has no entry for ${version}: add its date, title and notes in the site's repository`,
    );
  }
  for (const lang of LANGUAGES) {
    if (!release.title?.[lang] || !release.notes?.[lang]) {
      throw new Error(`releases.json's ${version} needs a title and notes in "${lang}"`);
    }
  }
  return release;
}

/** The release's body on GitHub: the English title in bold, then the English notes. */
export function releaseBody(release) {
  return `**${release.title.en}**\n\n${release.notes.en}\n`;
}

/**
 * Checks a signed build and writes what the release publishes: `<out>/assets/` (each installer,
 * its `.sig` and its `.minisig`, `latest.json`, `site-facts.json`) and `<out>/notes.md` (the
 * body). Every check runs before the first file is written, and an output folder that already
 * holds files is refused, so a folder either holds one whole release or nothing.
 */
export function stageRelease({ root, releases, installers: bundleDir, out, date }) {
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new Error(`${out} already holds files: remove it or name another folder`);
  }
  const version = agreedVersion(readVersions(root));
  const release = releaseOf(releases, version);
  const config = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const pubkey = config.plugins?.updater?.pubkey ?? "";
  const { downloads } = releaseDownloads(config.plugins?.updater?.endpoints ?? []);
  const key = updaterKey(pubkey);
  const installers = findInstallers(bundleDir, version);
  for (const installer of installers) {
    try {
      verifySignature(readFileSync(installer.path), installer.signature, pubkey);
    } catch (error) {
      throw new Error(`${installer.name}: ${error.message}`);
    }
  }

  const assets = join(out, "assets");
  mkdirSync(assets, { recursive: true });
  const written = [];
  const put = (name, content) => {
    writeFileSync(join(assets, name), content);
    written.push(name);
  };
  for (const installer of installers) {
    copyFileSync(installer.path, join(assets, installer.name));
    written.push(installer.name);
    put(`${installer.name}.sig`, installer.signature);
    put(`${installer.name}.minisig`, minisignature(installer.signature));
  }
  const manifest = updateManifest({
    version,
    date,
    notes: release.notes.en,
    downloads,
    installers,
  });
  put("latest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  put("site-facts.json", `${JSON.stringify(siteFacts({ version, key, installers }), null, 2)}\n`);
  writeFileSync(join(out, "notes.md"), releaseBody(release));
  return { version, assets: written };
}
