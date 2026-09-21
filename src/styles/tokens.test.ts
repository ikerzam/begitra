// The tokens file against design/tokens.json (both themes), and the token audit of the
// app: no colour literal outside tokens.css.

/// <reference types="node" />

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import tokens from "../../design/tokens.json";

// Vitest hands an empty string for a stylesheet import, `?raw` included: read the file
// (the working directory is the project root).
const tokensCss = readFileSync(resolve("src/styles/tokens.css"), "utf8");

const sources = import.meta.glob(["../**/*.vue", "../**/*.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The `--name: value;` declarations of one block of the stylesheet, lowercased values. */
function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    out.set(match[1]!, match[2]!.trim().toLowerCase());
  }
  return out;
}

function block(selector: string): string {
  const start = tokensCss.indexOf(`${selector} {`);
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
  const end = tokensCss.indexOf("\n}", start);
  return tokensCss.slice(start, end);
}

describe("design tokens", () => {
  const dark = declarations(block(":root"));
  const light = declarations(block('[data-theme="light"]'));
  const colours = Object.entries(tokens.colors) as [string, { dark: string; light: string }][];

  it("defines every colour of tokens.json for the dark theme with its value", () => {
    for (const [name, values] of colours) {
      expect(dark.get(name), name).toBe(values.dark.toLowerCase());
    }
  });

  it("defines every colour for the light theme, and nothing else there", () => {
    for (const [name, values] of colours) {
      // A light value equal to the dark one inherits from :root.
      const expected = values.light.toLowerCase();
      const actual = light.get(name) ?? dark.get(name);
      expect(actual, name).toBe(expected);
    }
    for (const name of light.keys()) {
      expect(tokens.colors, `${name} is not a colour token`).toHaveProperty(name);
    }
  });

  it("keeps colour literals out of the components and stores", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    const literal = /#[0-9a-f]{3,8}\b|\brgba?\(/i;
    const offenders = Object.entries(sources)
      .filter(([path]) => !path.endsWith(".test.ts") && !path.includes("/styles/"))
      .filter(([, source]) => literal.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
