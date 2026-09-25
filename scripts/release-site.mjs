// The parts of a release that decide what the server holds: the version the three manifests
// agree on, the installers a build left, the update manifest and the download page. Used by
// scripts/release.mjs and tested in tests/release.test.ts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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

/** The folder the updater endpoint lives in, with a trailing slash: where the site is served. */
export function siteBase(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || !url.pathname.endsWith("/latest.json")) {
    throw new Error(
      `the updater endpoint must be an https URL ending in /latest.json: ${endpoint}`,
    );
  }
  url.pathname = url.pathname.slice(0, -"latest.json".length);
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * The NSIS and MSI installers of `version` a Windows build left under `bundleDir`, each with its
 * updater signature: `{ kind, name, path, size, signature }`. Throws when one is missing, since
 * a release without both, or unsigned, is not one to publish.
 */
export function findInstallers(bundleDir, version) {
  const kinds = [
    { kind: "nsis", folder: "nsis", suffix: "-setup.exe" },
    { kind: "msi", folder: "msi", suffix: ".msi" },
  ];
  return kinds.map(({ kind, folder, suffix }) => {
    const dir = join(bundleDir, folder);
    const names = readdirSync(dir).filter(
      (name) => name.endsWith(suffix) && name.includes(`_${version}_`),
    );
    if (names.length !== 1) {
      throw new Error(
        `expected one ${kind} installer of ${version} in ${dir}, found ${names.length}`,
      );
    }
    const name = names[0];
    const path = join(dir, name);
    let signature;
    try {
      signature = readFileSync(`${path}.sig`, "utf8").trim();
    } catch {
      throw new Error(
        `${name} has no updater signature (${name}.sig): was the key in the environment?`,
      );
    }
    // A build without the updater's artifacts leaves the last signature beside a new installer.
    if (statSync(`${path}.sig`).mtimeMs < statSync(path).mtimeMs) {
      throw new Error(`${name}.sig is older than ${name}: build the release again with the key`);
    }
    return { kind, name, path, size: statSync(path).size, signature };
  });
}

/**
 * `latest.json` as the updater reads it: the version, its date and, per installer, the file's
 * URL and signature. `windows-x86_64` is the NSIS installer, as `tauri-action` writes it with
 * `updaterJsonPreferNsis`; a copy installed from the MSI finds its own entry first.
 */
export function updateManifest({ version, date, notes, base, installers }) {
  const url = (installer) => new URL(`releases/v${version}/${installer.name}`, base).toString();
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

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function megabytes(size) {
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** The site's page until the landing exists: the version, its date and the two installers. */
export function downloadPage({ version, date, installers }) {
  const label = { nsis: "Installer (.exe)", msi: "Windows Installer package (.msi)" };
  const items = installers
    .map(
      (installer) =>
        `      <li><a href="releases/v${escapeHtml(version)}/${escapeHtml(installer.name)}">${
          label[installer.kind] ?? escapeHtml(installer.name)
        }</a> <span>${megabytes(installer.size)}</span></li>`,
    )
    .join("\n");
  const day = date.toISOString().slice(0, 10);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Begitra ${escapeHtml(version)}</title>
    <style>
      :root { color-scheme: light dark; --fg: #1b1b1f; --muted: #5f6068; --bg: #fafafa; --link: #3b5bdb; }
      @media (prefers-color-scheme: dark) { :root { --fg: #e8e8ec; --muted: #9a9ba4; --bg: #111114; --link: #8da2fb; } }
      body { margin: 0; padding: 48px 16px; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
      main { max-width: 560px; margin: 0 auto; }
      h1 { font-size: 28px; margin: 0 0 4px; }
      p { color: var(--muted); margin: 0 0 24px; }
      ul { list-style: none; padding: 0; margin: 0 0 24px; }
      li { padding: 8px 0; }
      a { color: var(--link); }
      span { color: var(--muted); font-size: 14px; margin-left: 8px; }
      small { color: var(--muted); }
    </style>
  </head>
  <body>
    <main>
      <h1>Begitra ${escapeHtml(version)}</h1>
      <p>A desktop Git client for reading and reviewing code. Windows, ${day}.</p>
      <ul>
${items}
      </ul>
      <small>The installer is not code-signed yet: Windows SmartScreen may ask once (More info, then Run anyway). Installed copies update themselves from Settings, About.</small>
    </main>
  </body>
</html>
`;
}
