import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  agreedVersion,
  checkTag,
  findInstallers,
  installerFiles,
  minisignature,
  readVersions,
  releaseBody,
  releaseDownloads,
  releaseOf,
  siteFacts,
  stageRelease,
  updateManifest,
  updaterKey,
  verifySignature,
  type Release,
} from "../scripts/release-files.mjs";

const fixtures = join(__dirname, "fixtures", "release");
/** The public half of a throwaway key that signed the fixture installers with `tauri signer sign`. */
const throwawayKey = readFileSync(join(fixtures, "throwaway.pub"), "utf8").trim();
const nsisPath = join(fixtures, "bundle", "nsis", "Begitra_0.1.0_x64-setup.exe");
const msiPath = join(fixtures, "bundle", "msi", "Begitra_0.1.0_x64_en-US.msi");
const GITHUB = "https://github.com/ikerzam/begitra/releases/latest/download/latest.json";
const VPS = "https://begitra.ikerzam.tech/latest.json";
const DOWNLOADS = "https://github.com/ikerzam/begitra/releases/download/";

const folders: string[] = [];

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "begitra-release-"));
  folders.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repository root holding the three manifests at the given versions, and the updater's settings. */
function manifests(
  packageJson: string,
  cargo: string,
  tauri: string,
  updater = { pubkey: throwawayKey, endpoints: [GITHUB, VPS] },
): string {
  const root = folder();
  mkdirSync(join(root, "src-tauri"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "begitra", version: packageJson }),
  );
  writeFileSync(
    join(root, "src-tauri", "Cargo.toml"),
    `[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nversion = "${cargo}"\nedition = "2021"\n\n[package]\nname = "begitra"\nversion.workspace = true\n`,
  );
  writeFileSync(
    join(root, "src-tauri", "tauri.conf.json"),
    JSON.stringify({ version: tauri, plugins: { updater } }),
  );
  return root;
}

/** A minisign public key, as `plugins.updater.pubkey` holds one, from its id and its key bytes. */
function publicKey(id: Buffer, key: Buffer): string {
  const raw = Buffer.concat([Buffer.from("Ed"), id, key]);
  const hexId = Buffer.from(id).reverse().toString("hex").toUpperCase();
  const file = `untrusted comment: minisign public key: ${hexId}\n${raw.toString("base64")}\n`;
  return Buffer.from(file).toString("base64");
}

/** The id bytes of the throwaway key, as they sit in its public key and its signatures. */
function throwawayId(): Buffer {
  const text = Buffer.from(throwawayKey, "base64").toString("utf8");
  return Buffer.from(text.split("\n")[1] ?? "", "base64").subarray(2, 10);
}

/** An updater signature with one line of its minisign file replaced. */
function editSignature(signature: string, line: number, edit: (text: string) => string): string {
  const lines = Buffer.from(signature, "base64").toString("utf8").split("\n");
  lines[line] = edit(lines[line] ?? "");
  return Buffer.from(lines.join("\n")).toString("base64");
}

const signatureOf = (path: string) => readFileSync(`${path}.sig`, "utf8").trim();

const installers = [
  {
    kind: "nsis" as const,
    name: "Begitra_0.1.0_x64-setup.exe",
    signature: "nsis-sig",
    size: 5_922_260,
    sha256: "bc5a2517fde64c7b985cdf827cb52700f7a5cd5d5c5f04b736b2f9c9a15a3b45",
  },
  {
    kind: "msi" as const,
    name: "Begitra_0.1.0_x64_en-US.msi",
    signature: "msi-sig",
    size: 8_601_600,
    sha256: "4886d493041b3f0d555afc6933c1176d94a34eda6749876b51b36ce0d79b9904",
  },
];

const releases: Release[] = [
  {
    version: "0.2.0",
    date: "2026-09-26",
    title: { en: "Two", es: "Dos" },
    notes: { en: "b", es: "b" },
  },
  {
    version: "0.1.0",
    date: "2026-09-25",
    title: { en: "One", es: "Una" },
    notes: { en: "The first notes.", es: "Las primeras notas." },
  },
];

describe("the version", () => {
  it("is the one the three manifests agree on", () => {
    expect(agreedVersion(readVersions(manifests("0.1.0", "0.1.0", "0.1.0")))).toBe("0.1.0");
  });

  it("stops the release and names each file when they differ", () => {
    const versions = readVersions(manifests("0.2.0", "0.1.0", "0.1.0"));
    expect(() => agreedVersion(versions)).toThrow(
      "package.json: 0.2.0, src-tauri/Cargo.toml: 0.1.0, tauri.conf.json: 0.1.0",
    );
  });

  it("is the one the tag names", () => {
    expect(() => checkTag("0.1.0", "v0.1.0")).not.toThrow();
    expect(() => checkTag("0.1.0", "v0.1.1")).toThrow("v0.1.1 does not name 0.1.0");
    expect(() => checkTag("0.1.0", "0.1.0")).toThrow("does not name");
  });
});

describe("where a release's files are", () => {
  it("is the GitHub repository whose latest release the app asks first", () => {
    expect(releaseDownloads([GITHUB, VPS])).toEqual({
      repository: "ikerzam/begitra",
      downloads: DOWNLOADS,
    });
  });

  it("refuses a first endpoint that is not a GitHub release's manifest", () => {
    expect(() => releaseDownloads([VPS, GITHUB])).toThrow("GitHub");
    expect(() => releaseDownloads([])).toThrow("GitHub");
    expect(() => releaseDownloads([GITHUB.replace("https:", "http:")])).toThrow("GitHub");
    expect(() =>
      releaseDownloads(["https://github.com/ikerzam/begitra/releases/download/v0.1.0/latest.json"]),
    ).toThrow("GitHub");
  });
});

describe("the installers a build left", () => {
  function bundles(withSignatures: boolean): string {
    const dir = folder();
    for (const [sub, name] of [
      ["nsis", "Begitra_0.1.0_x64-setup.exe"],
      ["msi", "Begitra_0.1.0_x64_en-US.msi"],
    ] as const) {
      mkdirSync(join(dir, sub));
      writeFileSync(join(dir, sub, name), "installer");
      if (withSignatures) writeFileSync(join(dir, sub, `${name}.sig`), `${sub}-signature\n`);
      // An earlier version's installer stays in the folder and is not this release's.
      writeFileSync(join(dir, sub, name.replace("0.1.0", "0.0.9")), "older");
    }
    return dir;
  }

  it("are the NSIS and MSI installers of the version, each with its signature", () => {
    const found = findInstallers(bundles(true), "0.1.0");
    const sha256 = createHash("sha256").update("installer").digest("hex");
    expect(
      found.map(({ kind, name, signature, size, sha256 }) => ({
        kind,
        name,
        signature,
        size,
        sha256,
      })),
    ).toEqual([
      {
        kind: "nsis",
        name: "Begitra_0.1.0_x64-setup.exe",
        signature: "nsis-signature",
        size: 9,
        sha256,
      },
      {
        kind: "msi",
        name: "Begitra_0.1.0_x64_en-US.msi",
        signature: "msi-signature",
        size: 9,
        sha256,
      },
    ]);
  });

  it("are found before they are signed, one of each kind", () => {
    const dir = bundles(false);
    expect(installerFiles(dir, "0.1.0")).toEqual([
      {
        kind: "nsis",
        name: "Begitra_0.1.0_x64-setup.exe",
        path: join(dir, "nsis", "Begitra_0.1.0_x64-setup.exe"),
      },
      {
        kind: "msi",
        name: "Begitra_0.1.0_x64_en-US.msi",
        path: join(dir, "msi", "Begitra_0.1.0_x64_en-US.msi"),
      },
    ]);
  });

  it("stop the release when a signature is missing", () => {
    expect(() => findInstallers(bundles(false), "0.1.0")).toThrow("no updater signature");
  });

  it("stop the release when the version was not built", () => {
    expect(() => findInstallers(bundles(true), "0.2.0")).toThrow("found 0");
  });
});

describe("an updater signature", () => {
  it("verifies with the key that made it", () => {
    for (const path of [nsisPath, msiPath]) {
      expect(() =>
        verifySignature(readFileSync(path), signatureOf(path), throwawayKey),
      ).not.toThrow();
    }
  });

  it("refuses a file that changed by one byte", () => {
    const bytes = Buffer.from(readFileSync(nsisPath));
    const at = bytes.length - 2;
    bytes.writeUInt8(bytes.readUInt8(at) ^ 1, at);
    expect(() => verifySignature(bytes, signatureOf(nsisPath), throwawayKey)).toThrow(
      "does not match",
    );
  });

  it("refuses another file's signature", () => {
    expect(() =>
      verifySignature(readFileSync(nsisPath), signatureOf(msiPath), throwawayKey),
    ).toThrow("does not match");
  });

  it("refuses a signature made by another key, naming both", () => {
    const other = publicKey(Buffer.from("0123456789abcdef", "hex"), randomBytes(32));
    expect(() => verifySignature(readFileSync(nsisPath), signatureOf(nsisPath), other)).toThrow(
      "signed by the key 487E40F60BD8B667, and the app trusts EFCDAB8967452301",
    );
  });

  it("refuses a key that shares the id but not the key", () => {
    const impostor = publicKey(throwawayId(), randomBytes(32));
    expect(() => verifySignature(readFileSync(nsisPath), signatureOf(nsisPath), impostor)).toThrow(
      "does not match",
    );
  });

  it("refuses a trusted comment that changed", () => {
    const signature = editSignature(signatureOf(nsisPath), 2, (line) =>
      line.replace("file:", "file:x"),
    );
    expect(() => verifySignature(readFileSync(nsisPath), signature, throwawayKey)).toThrow(
      "trusted comment",
    );
  });

  it("refuses any form but the prehashed one Tauri writes", () => {
    const signature = editSignature(signatureOf(nsisPath), 1, (line) => {
      const bytes = Buffer.from(line, "base64");
      bytes.write("Ed", 0, "latin1");
      return bytes.toString("base64");
    });
    expect(() => verifySignature(readFileSync(nsisPath), signature, throwawayKey)).toThrow('"ED"');
    expect(() =>
      verifySignature(
        readFileSync(nsisPath),
        Buffer.from("hello").toString("base64"),
        throwawayKey,
      ),
    ).toThrow("minisign");
  });
});

describe("latest.json", () => {
  it("names the version, its date, and each installer's address on the release and signature", () => {
    const manifest = updateManifest({
      version: "0.1.0",
      date: new Date("2026-09-25T08:30:12.345Z"),
      notes: "Begitra 0.1.0",
      downloads: DOWNLOADS,
      installers,
    });
    const nsis = {
      signature: "nsis-sig",
      url: `${DOWNLOADS}v0.1.0/Begitra_0.1.0_x64-setup.exe`,
    };
    expect(manifest).toEqual({
      version: "0.1.0",
      notes: "Begitra 0.1.0",
      pub_date: "2026-09-25T08:30:12Z",
      platforms: {
        "windows-x86_64": nsis,
        "windows-x86_64-nsis": nsis,
        "windows-x86_64-msi": {
          signature: "msi-sig",
          url: `${DOWNLOADS}v0.1.0/Begitra_0.1.0_x64_en-US.msi`,
        },
      },
    });
  });

  it("needs both installers", () => {
    expect(() =>
      updateManifest({
        version: "0.1.0",
        date: new Date(),
        notes: "",
        downloads: DOWNLOADS,
        installers: installers.slice(0, 1),
      }),
    ).toThrow("NSIS and the MSI");
  });
});

describe("what a visitor can check", () => {
  it("is the updater's public key as minisign takes it, with its key id", () => {
    const id = Buffer.from("0123456789abcdef", "hex");
    const raw = Buffer.concat([Buffer.from("Ed"), Buffer.from(id).reverse(), Buffer.alloc(32, 7)]);
    const file = `untrusted comment: minisign public key: 0123456789ABCDEF\n${raw.toString("base64")}\n`;
    expect(updaterKey(Buffer.from(file).toString("base64"))).toEqual({
      key: raw.toString("base64"),
      id: "0123456789ABCDEF",
    });
    expect(() => updaterKey(Buffer.from("not a key").toString("base64"))).toThrow("minisign");
  });

  it("is the minisign signature file an updater signature holds", () => {
    const file =
      "untrusted comment: signature from tauri secret key\nRUQabc\ntrusted comment: timestamp:1\tfile:a.exe\nxyz==";
    expect(minisignature(Buffer.from(file).toString("base64"))).toBe(`${file}\n`);
    expect(() => minisignature(Buffer.from("hello").toString("base64"))).toThrow("minisign");
  });

  it("is in the facts the site reads, without the build's paths or the updater signatures", () => {
    const key = updaterKey(throwawayKey);
    expect(
      siteFacts({
        version: "0.1.0",
        key,
        installers: installers.map((installer) => ({ ...installer, path: "C:/build" })),
      }),
    ).toEqual({
      version: "0.1.0",
      key,
      installers: installers.map(({ kind, name, size, sha256 }) => ({ kind, name, size, sha256 })),
    });
  });
});

describe("the notes of a version", () => {
  it("are its entry in the site's releases.json", () => {
    expect(releaseOf(releases, "0.1.0").title.en).toBe("One");
  });

  it("stop a release that has none, in either language", () => {
    expect(() => releaseOf(releases, "0.3.0")).toThrow("no entry for 0.3.0");
    const partial = [{ ...releases[0], title: { en: "Two" } }] as Release[];
    expect(() => releaseOf(partial, "0.2.0")).toThrow('"es"');
  });

  it("make the release's body: the English title, then the English notes", () => {
    expect(releaseBody(releaseOf(releases, "0.1.0"))).toBe("**One**\n\nThe first notes.\n");
  });
});

describe("staging a release", () => {
  const date = new Date("2026-10-01T09:00:00Z");

  it("writes the files to attach and the release's body, once the app's key verifies each signature", () => {
    const out = join(folder(), "release");
    const staged = stageRelease({
      root: manifests("0.1.0", "0.1.0", "0.1.0"),
      releases,
      installers: join(fixtures, "bundle"),
      out,
      date,
    });
    const assets = join(out, "assets");
    expect(staged).toEqual({
      version: "0.1.0",
      assets: [
        "Begitra_0.1.0_x64-setup.exe",
        "Begitra_0.1.0_x64-setup.exe.sig",
        "Begitra_0.1.0_x64-setup.exe.minisig",
        "Begitra_0.1.0_x64_en-US.msi",
        "Begitra_0.1.0_x64_en-US.msi.sig",
        "Begitra_0.1.0_x64_en-US.msi.minisig",
        "latest.json",
        "site-facts.json",
      ],
    });
    expect(readFileSync(join(assets, "Begitra_0.1.0_x64-setup.exe"))).toEqual(
      readFileSync(nsisPath),
    );
    expect(readFileSync(join(assets, "Begitra_0.1.0_x64_en-US.msi.minisig"), "utf8")).toBe(
      minisignature(signatureOf(msiPath)),
    );
    const manifest = JSON.parse(readFileSync(join(assets, "latest.json"), "utf8"));
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.notes).toBe("The first notes.");
    expect(manifest.pub_date).toBe("2026-10-01T09:00:00Z");
    expect(manifest.platforms["windows-x86_64"]).toEqual({
      signature: signatureOf(nsisPath),
      url: `${DOWNLOADS}v0.1.0/Begitra_0.1.0_x64-setup.exe`,
    });
    const facts = JSON.parse(readFileSync(join(assets, "site-facts.json"), "utf8"));
    expect(facts.key).toEqual(updaterKey(throwawayKey));
    expect(facts.installers[1]).toEqual({
      kind: "msi",
      name: "Begitra_0.1.0_x64_en-US.msi",
      size: readFileSync(msiPath).length,
      sha256: createHash("sha256").update(readFileSync(msiPath)).digest("hex"),
    });
    expect(readFileSync(join(out, "notes.md"), "utf8")).toBe("**One**\n\nThe first notes.\n");
  });

  it("refuses installers the app's key did not sign, and writes nothing", () => {
    const out = join(folder(), "release");
    const other = publicKey(Buffer.from("0123456789abcdef", "hex"), randomBytes(32));
    expect(() =>
      stageRelease({
        root: manifests("0.1.0", "0.1.0", "0.1.0", { pubkey: other, endpoints: [GITHUB, VPS] }),
        releases,
        installers: join(fixtures, "bundle"),
        out,
        date,
      }),
    ).toThrow("Begitra_0.1.0_x64-setup.exe: signed by the key 487E40F60BD8B667");
    expect(existsSync(out)).toBe(false);
  });

  it("stops when the version has no notes, and writes nothing", () => {
    const out = join(folder(), "release");
    expect(() =>
      stageRelease({
        root: manifests("0.3.0", "0.3.0", "0.3.0"),
        releases,
        installers: join(fixtures, "bundle"),
        out,
        date,
      }),
    ).toThrow("no entry for 0.3.0");
    expect(existsSync(out)).toBe(false);
  });
});
