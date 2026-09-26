import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  agreedVersion,
  findInstallers,
  hashedName,
  ICONS,
  loadIcons,
  megabytes,
  minisignature,
  pagePath,
  readVersions,
  releaseOf,
  siteBase,
  sitePages,
  updateManifest,
  updaterKey,
  type Release,
  type SiteInput,
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

  it("gives sizes in binary megabytes, as Windows shows them", () => {
    expect(megabytes(5_922_260)).toBe("5.6 MB");
    expect(megabytes(8_601_600, "es-ES")).toBe("8,2 MB");
  });
});

describe("the notes of a version", () => {
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
      notes: { en: "a", es: "a" },
    },
  ];

  it("are its entry in site/releases.json", () => {
    expect(releaseOf(releases, "0.1.0").title.en).toBe("One");
  });

  it("stop a release that has none, in either language", () => {
    expect(() => releaseOf(releases, "0.3.0")).toThrow("no entry for 0.3.0");
    const partial = [{ ...releases[0], title: { en: "Two" } }] as Release[];
    expect(() => releaseOf(partial, "0.2.0")).toThrow('"es"');
  });
});

describe("the site", () => {
  const root = join(__dirname, "..");
  const json = (...path: string[]) => JSON.parse(readFileSync(join(root, ...path), "utf8"));
  const releases: Release[] = [
    {
      version: "0.1.0",
      date: "2026-09-25",
      title: { en: "The <b>first</b> one", es: "La primera" },
      notes: { en: "Everything.", es: "Todo." },
    },
    {
      version: "0.0.9",
      date: "2026-09-20",
      title: { en: "Older", es: "Anterior" },
      notes: { en: "x", es: "x" },
    },
  ];
  const icons = loadIcons(
    join(root, "node_modules", "@lucide", "vue", "dist", "esm", "icons"),
    ICONS,
  );
  // Every asset under a recognisable name, as the staging's hashed names would be.
  const assets = new Proxy({}, { get: (_, name) => `hashed-${String(name)}` }) as Record<
    string,
    string
  >;

  function site(donate: string | null = null): Record<string, string> {
    const input: SiteInput = {
      version: "0.1.0",
      release: releases[0]!,
      releases,
      installers,
      key: { key: "RWQkey", id: "0123456789ABCDEF" },
      base: "https://begitra.ikerzam.tech/",
      strings: { en: json("site", "strings", "en.json"), es: json("site", "strings", "es.json") },
      site: { publisher: "Iker Z.", donate },
      assets,
      images: json("site", "images.json"),
      icons,
    };
    return sitePages(input);
  }

  it("is the product and download pages in each language, the robots file and the sitemap", () => {
    expect(Object.keys(site()).sort()).toEqual([
      "download/index.html",
      "es/download/index.html",
      "es/index.html",
      "index.html",
      "robots.txt",
      "sitemap.xml",
    ]);
    expect(pagePath("es", "download")).toBe("es/download/");
    expect(site()["sitemap.xml"]).toContain("<loc>https://begitra.ikerzam.tech/es/download/</loc>");
    expect(site()["robots.txt"]).toContain("Sitemap: https://begitra.ikerzam.tech/sitemap.xml");
  });

  it("downloads the version's installer from the product page, in English at the root", () => {
    const page = site()["index.html"]!;
    expect(page).toContain('<html lang="en">');
    expect(page).toContain('href="releases/v0.1.0/Begitra_0.1.0_x64-setup.exe"');
    expect(page).toContain('<link rel="canonical" href="https://begitra.ikerzam.tech/">');
    expect(page).toContain('hreflang="es" href="https://begitra.ikerzam.tech/es/"');
    expect(page).toContain('hreflang="x-default" href="https://begitra.ikerzam.tech/"');
    expect(page).toContain('content="https://begitra.ikerzam.tech/assets/hashed-og.png"');
    expect(page).toContain('href="es/" hreflang="es" lang="es"');
    expect(page).toContain('href="assets/hashed-site.css"');
    expect(page).toContain("5.6 MB");
  });

  it("links the Spanish pages relative to their own folder", () => {
    const product = site()["es/index.html"]!;
    expect(product).toContain('<html lang="es">');
    expect(product).toContain("Mira antes de fusionar.");
    expect(product).toContain('href="../releases/v0.1.0/Begitra_0.1.0_x64-setup.exe"');
    expect(product).toContain('href="../" hreflang="en" lang="en"');
    expect(product).toContain('src="../assets/hashed-icon.svg"');
    const download = site()["es/download/index.html"]!;
    expect(download).toContain('href="../../releases/v0.1.0/Begitra_0.1.0_x64_en-US.msi"');
    expect(download).toContain('href="../../download/" hreflang="en" lang="en"');
    expect(download).toContain("8,2 MB");
  });

  it("shows each installer's size, SHA-256 and signature, and the command that checks it", () => {
    const page = site()["download/index.html"]!;
    for (const installer of installers) {
      expect(page).toContain(`<code>${installer.sha256}</code>`);
      expect(page).toContain(`href="../releases/v0.1.0/${installer.name}.minisig"`);
    }
    expect(page).toContain("minisign -Vm Begitra_0.1.0_x64-setup.exe -P RWQkey");
    expect(page).toContain("Get-FileHash .\\Begitra_0.1.0_x64-setup.exe");
    expect(page).toContain('href="../releases/v0.0.9/Begitra_0.0.9_x64-setup.exe"');
  });

  it("runs no script and escapes what it prints", () => {
    for (const page of Object.values(site())) {
      expect(page).not.toMatch(/<script/i);
      expect(page).not.toMatch(/ style="/);
    }
    expect(site()["index.html"]).toContain("The &lt;b&gt;first&lt;/b&gt; one");
  });

  it("links the donation page only when there is one", () => {
    for (const page of Object.values(site())) expect(page).not.toContain("ko-fi");
    const pages = site("https://ko-fi.com/begitra");
    // The top bar, the answer on the price and the footer; the download page's card too.
    expect(pages["index.html"]!.match(/href="https:\/\/ko-fi\.com\/begitra"/g)).toHaveLength(3);
    expect(
      pages["download/index.html"]!.match(/href="https:\/\/ko-fi\.com\/begitra"/g),
    ).toHaveLength(3);
  });
});

describe("the site's assets", () => {
  it("carry the hash of their content in their name", () => {
    const name = hashedName("site.css", "body{}");
    expect(name).toMatch(/^site\.[0-9a-f]{10}\.css$/);
    expect(hashedName("site.css", "body{}")).toBe(name);
    expect(hashedName("site.css", "body{ }")).not.toBe(name);
  });

  it("draw Lucide's icons inline", () => {
    const icons = loadIcons(
      join(__dirname, "..", "node_modules", "@lucide", "vue", "dist", "esm", "icons"),
      ["heart"],
    );
    expect(icons.heart).toMatch(/^<path d="M2 9\.5[^"]*"\/>$/);
  });
});
