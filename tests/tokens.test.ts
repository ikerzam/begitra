import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const tokensJson = JSON.parse(readFileSync(resolve(root, "design/tokens.json"), "utf8")) as {
  colors: Record<string, { dark: string; light: string }>;
  fonts: Record<string, string>;
  sizes: Record<string, number>;
  ratios: Record<string, number>;
  shadows: Record<string, string>;
};
const tokensCss = readFileSync(resolve(root, "src/styles/tokens.css"), "utf8");

function block(selector: string): Map<string, string> {
  const start = tokensCss.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`selector ${selector} not found in tokens.css`);
  const end = tokensCss.indexOf("\n}", start);
  const body = tokensCss.slice(start, end);
  const map = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    map.set(match[1] ?? "", (match[2] ?? "").trim());
  }
  return map;
}

const dark = block(":root");
const light = block('[data-theme="light"]');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(vue|ts)$/.test(entry) && !/\.test\.ts$/.test(entry)) out.push(path);
  }
  return out;
}

describe("design tokens", () => {
  it("declares every colour token with the dark value from tokens.json", () => {
    for (const [name, values] of Object.entries(tokensJson.colors)) {
      expect(dark.get(name), name).toBe(values.dark.toLowerCase());
    }
  });

  it("remaps the light theme where it differs and inherits the rest", () => {
    for (const [name, values] of Object.entries(tokensJson.colors)) {
      const expected = values.light.toLowerCase();
      const actual = light.get(name) ?? dark.get(name);
      expect(actual, name).toBe(expected);
    }
    // And nothing else lives in the light block: a size or a stray property there would
    // apply to one theme only.
    for (const name of light.keys()) {
      expect(tokensJson.colors, name).toHaveProperty(name);
    }
  });

  it("declares sizes in pixels, ratios unitless and fonts by family name", () => {
    for (const [name, px] of Object.entries(tokensJson.sizes)) {
      expect(dark.get(name), name).toBe(`${px}px`);
    }
    for (const [name, ratio] of Object.entries(tokensJson.ratios)) {
      expect(dark.get(name), name).toBe(String(ratio));
    }
    for (const [name, family] of Object.entries(tokensJson.fonts)) {
      expect(dark.get(name), name).toContain(`"${family}"`);
    }
    for (const [name, value] of Object.entries(tokensJson.shadows)) {
      expect(dark.get(name), name).toBe(value);
    }
  });

  it("has no colour literals outside the token files", () => {
    const literal =
      /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(?:rgba?|hsla?|oklch)\(/;
    const offenders = walk(resolve(root, "src"))
      .filter((file) => !file.includes(join("src", "styles")))
      .filter((file) => literal.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});
