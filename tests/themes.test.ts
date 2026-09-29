import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  contrast,
  deriveTokens,
  FLOORS,
  lift,
  mix,
  mixToContrast,
  ON_FILL_FLOOR,
  type Palette,
} from "../scripts/themes.mjs";

const root = resolve(__dirname, "..");
const tokensJson = JSON.parse(readFileSync(resolve(root, "design/tokens.json"), "utf8")) as {
  colors: Record<string, { dark: string; light: string }>;
};
const palettes = (
  JSON.parse(readFileSync(resolve(root, "design/themes.json"), "utf8")) as { themes: Palette[] }
).themes;
const themesCss = readFileSync(resolve(root, "src/styles/themes.css"), "utf8");
const names = Object.keys(tokensJson.colors);

/** The declarations of one `[data-theme="<id>"]` block of themes.css. */
function block(id: string): Map<string, string> {
  const start = themesCss.indexOf(`[data-theme="${id}"] {`);
  if (start < 0) throw new Error(`no block for ${id}`);
  const body = themesCss.slice(start, themesCss.indexOf("\n}", start));
  const map = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    map.set(match[1] ?? "", (match[2] ?? "").trim());
  }
  return map;
}

describe("theme derivation", () => {
  it("measures contrast as WCAG does", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    // A colour with alpha is measured over the background it sits on.
    expect(contrast("#00000000", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("lifts a colour to its floor in its own hue, away from the background", () => {
    // Ayu Light's functions: darker on a light background.
    const onLight = lift("#eba400", "#fcfcfc", 3);
    expect(contrast(onLight, "#fcfcfc")).toBeGreaterThanOrEqual(3);
    expect(contrast(onLight, "#fcfcfc")).toBeLessThan(3.2);
    expect(onLight).not.toBe("#eba400");
    // One Dark's comments: lighter on a dark background.
    const onDark = lift("#5c6370", "#282c34", 3);
    expect(contrast(onDark, "#282c34")).toBeGreaterThanOrEqual(3);
    // A colour already over its floor stays as it is.
    expect(lift("#98c379", "#282c34", 3)).toBe("#98c379");
  });

  it("mixes toward the background as far as a contrast allows", () => {
    const muted = mixToContrast("#ededed", "#000000", "#000000", 4.6);
    expect(contrast(muted, "#000000")).toBeGreaterThanOrEqual(4.6);
    expect(contrast(muted, "#000000")).toBeLessThan(4.7);
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });

  it("derives every colour token of a palette and nothing else", () => {
    const oneDark = palettes.find((palette) => palette.id === "one-dark");
    if (!oneDark) throw new Error("One Dark is missing");
    const { tokens, lifts } = deriveTokens(oneDark, names);
    expect([...tokens.keys()]).toEqual(names);
    expect(tokens.get("--bg-app")).toBe("#282c34");
    expect(tokens.get("--syntax-keyword")).toBe("#c678dd");
    expect(tokens.get("--diff-add-bg")).toBe("#98c3792e");
    // The comment colour is under 3:1 in the original and is lifted.
    expect(lifts.map((l) => l.token)).toContain("--syntax-comment");
  });
});

describe("themes.css", () => {
  it("equals what the script writes from design/themes.json", () => {
    // Fails with the name of the stale file when the palettes changed without a run.
    expect(() =>
      execFileSync(process.execPath, [resolve(root, "scripts/generate-themes.mjs"), "--check"], {
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("gives Begitra's dark colours to the dark attribute, for a code theme in a light window", () => {
    const dark = block("dark");
    for (const [name, values] of Object.entries(tokensJson.colors)) {
      expect(dark.get(name), name).toBe(values.dark.toLowerCase());
    }
  });

  it.each(palettes.map((palette) => [palette.id, palette] as const))(
    "%s defines every colour token and meets its floors",
    (id, palette) => {
      const tokens = block(id);
      expect([...tokens.keys()].sort()).toEqual([...names].sort());
      const bg = tokens.get("--bg-app") ?? "";
      expect(bg).toBe(palette.bg.toLowerCase());
      for (const [name, floor] of Object.entries(FLOORS)) {
        expect(contrast(tokens.get(name) ?? "", bg), `${id} ${name}`).toBeGreaterThanOrEqual(floor);
      }
      const white = tokens.get("--white") ?? "";
      for (const fill of ["--danger", "--ref-current"]) {
        expect(
          contrast(white, tokens.get(fill) ?? ""),
          `${id} --white on ${fill}`,
        ).toBeGreaterThanOrEqual(ON_FILL_FLOOR);
      }
      expect(themesCss).toContain(`[data-theme="${id}"] {\n  color-scheme: ${palette.brightness};`);
    },
  );
});
