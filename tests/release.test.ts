import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  agreedVersion,
  downloadPage,
  findInstallers,
  readVersions,
  siteBase,
  updateManifest,
} from "../scripts/release-site.mjs";

const folders: string[] = [];

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), "begitra-release-"));
  folders.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repository root holding the three manifests at the given versions. */
function manifests(packageJson: string, cargo: string, tauri: string): string {
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
  writeFileSync(join(root, "src-tauri", "tauri.conf.json"), JSON.stringify({ version: tauri }));
  return root;
}

const installers = [
  {
    kind: "nsis" as const,
    name: "Begitra_0.1.0_x64-setup.exe",
    signature: "nsis-sig",
    size: 7_340_032,
  },
  {
    kind: "msi" as const,
    name: "Begitra_0.1.0_x64_en-US.msi",
    signature: "msi-sig",
    size: 9_437_184,
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
});

describe("the site's address", () => {
  it("is the folder of the updater endpoint", () => {
    expect(siteBase("https://begitra.ikerzam.tech/latest.json")).toBe(
      "https://begitra.ikerzam.tech/",
    );
    expect(siteBase("https://example.com/begitra/latest.json")).toBe(
      "https://example.com/begitra/",
    );
  });

  it("refuses an endpoint the updater would not trust or the site cannot serve", () => {
    expect(() => siteBase("http://begitra.ikerzam.tech/latest.json")).toThrow("https");
    expect(() => siteBase("https://begitra.ikerzam.tech/update.json")).toThrow("latest.json");
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
    expect(
      found.map(({ kind, name, signature, size }) => ({ kind, name, signature, size })),
    ).toEqual([
      { kind: "nsis", name: "Begitra_0.1.0_x64-setup.exe", signature: "nsis-signature", size: 9 },
      { kind: "msi", name: "Begitra_0.1.0_x64_en-US.msi", signature: "msi-signature", size: 9 },
    ]);
  });

  it("stop the release when a signature is missing", () => {
    expect(() => findInstallers(bundles(false), "0.1.0")).toThrow("no updater signature");
  });

  it("stop the release when a signature is older than its installer", () => {
    const dir = bundles(true);
    // An unsigned build replaced the installer and left the last signature.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(join(dir, "nsis", "Begitra_0.1.0_x64-setup.exe.sig"), old, old);
    expect(() => findInstallers(dir, "0.1.0")).toThrow("older than");
  });

  it("stop the release when the version was not built", () => {
    expect(() => findInstallers(bundles(true), "0.2.0")).toThrow("found 0");
  });
});

describe("latest.json", () => {
  it("names the version, its date and each installer's address and signature", () => {
    const manifest = updateManifest({
      version: "0.1.0",
      date: new Date("2026-09-25T08:30:12.345Z"),
      notes: "Begitra 0.1.0",
      base: "https://begitra.ikerzam.tech/",
      installers,
    });
    const nsis = {
      signature: "nsis-sig",
      url: "https://begitra.ikerzam.tech/releases/v0.1.0/Begitra_0.1.0_x64-setup.exe",
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
          url: "https://begitra.ikerzam.tech/releases/v0.1.0/Begitra_0.1.0_x64_en-US.msi",
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
        base: "https://begitra.ikerzam.tech/",
        installers: installers.slice(0, 1),
      }),
    ).toThrow("NSIS and the MSI");
  });
});

describe("the download page", () => {
  it("links each installer under the version's folder with its size", () => {
    const page = downloadPage({
      version: "0.1.0",
      date: new Date("2026-09-25T08:30:00Z"),
      installers,
    });
    expect(page).toContain(
      '<a href="releases/v0.1.0/Begitra_0.1.0_x64-setup.exe">Installer (.exe)</a>',
    );
    expect(page).toContain('<a href="releases/v0.1.0/Begitra_0.1.0_x64_en-US.msi">');
    expect(page).toContain("7.0 MB");
    expect(page).toContain("Windows, 2026-09-25");
  });

  it("escapes what it prints", () => {
    const page = downloadPage({
      version: '0.1.0"><script>',
      date: new Date("2026-09-25T08:30:00Z"),
      installers,
    });
    expect(page).not.toContain("<script>");
    expect(page).toContain("0.1.0&quot;&gt;&lt;script&gt;");
  });
});
