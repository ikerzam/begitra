#!/usr/bin/env node
// Generates src/styles/themes.css and src/styles/themes.ts from design/themes.json: each
// palette's colour tokens, derived and lifted to their contrast floors by scripts/themes.mjs.
// Prints every colour it lifted. `--check` writes nothing and fails when a file differs.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCss, buildTs, deriveTokens, ON_FILL_FLOOR } from "./themes.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const tokens = JSON.parse(readFileSync(resolve(root, "design/tokens.json"), "utf8"));
const { themes: palettes } = JSON.parse(readFileSync(resolve(root, "design/themes.json"), "utf8"));
const names = Object.keys(tokens.colors);

const dark = new Map(names.map((name) => [name, tokens.colors[name].dark.toLowerCase()]));
const themes = palettes.map((palette) => {
  const { tokens: derived, lifts, onFill } = deriveTokens(palette, names);
  for (const { token, from, to } of lifts) {
    console.log(`${palette.id}: ${token} ${from} -> ${to}`);
  }
  if (onFill < ON_FILL_FLOOR) {
    console.log(`${palette.id}: --white reads ${onFill.toFixed(2)}:1 on its fills`);
  }
  return { palette, tokens: derived };
});

const outputs = [
  ["src/styles/themes.css", buildCss(dark, themes)],
  ["src/styles/themes.ts", buildTs(palettes)],
];

if (process.argv.includes("--check")) {
  const stale = outputs.filter(
    ([path, text]) => readFileSync(resolve(root, path), "utf8") !== text,
  );
  for (const [path] of stale) console.error(`${path} differs from what design/themes.json gives`);
  process.exit(stale.length > 0 ? 1 : 0);
}
for (const [path, text] of outputs) writeFileSync(resolve(root, path), text);
