#!/usr/bin/env node
// Generates the app icons in src-tauri/icons from the sources in design/brand/: the square
// icon for Windows and Linux, and the inset one macOS draws its icons in for icon.icns.
// `tauri icon` takes one source, so each runs into its own folder and the files the bundle
// already lists are copied from the right one. The app's build script is touched last: it
// embeds icon.ico in the Windows executable and does not run again on an icon change alone.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const icons = join(root, "src-tauri", "icons");
const cli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");

function generate(source) {
  const out = mkdtempSync(join(tmpdir(), "begitra-icons-"));
  execFileSync(
    process.execPath,
    [cli, "icon", join(root, "design", "brand", source), "--output", out],
    { stdio: "inherit" },
  );
  return out;
}

const square = generate("begitra-icon.svg");
const inset = generate("begitra-icon-macos.svg");
try {
  for (const name of readdirSync(icons)) {
    copyFileSync(join(name === "icon.icns" ? inset : square, name), join(icons, name));
  }
} finally {
  rmSync(square, { recursive: true, force: true });
  rmSync(inset, { recursive: true, force: true });
}
const now = new Date();
utimesSync(join(root, "src-tauri", "build.rs"), now, now);
