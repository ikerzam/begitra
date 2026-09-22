import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { compile } from "@tailwindcss/node";
import { describe, expect, it } from "vitest";

const stylesDir = resolve(__dirname, "../src/styles");
const theme = readFileSync(resolve(stylesDir, "tailwind-theme.css"), "utf8");

/** Names declared in one theme namespace, e.g. `color` gives `["app", "raised", ...]`. */
function themeNames(namespace: string): string[] {
  const pattern = new RegExp(`^\\s+--${namespace}-([a-z0-9-]+):`, "gm");
  return [...theme.matchAll(pattern)]
    .map((match) => match[1] ?? "")
    .filter((name) => name !== "" && !name.includes("--"));
}

const candidates = [
  ...themeNames("color").flatMap((name) => [`bg-${name}`, `text-${name}`, `border-${name}`]),
  ...themeNames("spacing").flatMap((name) => [`h-${name}`, `p-${name}`]),
  ...themeNames("text").map((name) => `text-${name}`),
  ...themeNames("radius").map((name) => `rounded-${name}`),
  ...themeNames("font").map((name) => `font-${name}`),
  ...themeNames("shadow").map((name) => `shadow-${name}`),
];

async function build(classes: string[]): Promise<string> {
  const compiler = await compile(readFileSync(resolve(stylesDir, "main.css"), "utf8"), {
    base: stylesDir,
    onDependency: () => {},
  });
  return compiler.build(classes).replace(/\s+/g, "");
}

describe("tailwind theme", () => {
  it("turns every token into a utility that resolves to the token variable", async () => {
    const css = await build(candidates);
    for (const candidate of candidates) {
      expect(css, candidate).toContain(`.${candidate}{`);
    }
    expect(css).toContain(".bg-app{background-color:var(--bg-app)");
    expect(css).toContain(".text-fg-secondary{color:var(--text-secondary)");
    expect(css).toContain(".h-row-graph{height:var(--row-graph)");
    expect(css).toContain(".p-5{padding:var(--space-5)");
    expect(css).toContain(".rounded-md{border-radius:var(--radius-md)");
    expect(css).toContain(".font-mono{font-family:var(--font-mono)");
    expect(css).toContain(
      ".text-code{font-size:var(--code-size);line-height:var(--tw-leading,var(--code-leading))",
    );
  });

  it("emits no theme variables of its own, so the tokens file stays the single source", async () => {
    const css = await build(["bg-app", "text-sm", "font-mono", "rounded-md"]);
    expect(css).not.toMatch(/--text-sm:var\(--text-sm\)/);
    expect(css).not.toMatch(/--font-mono:ui-monospace/);
    expect(css).not.toMatch(/--radius-md:0\.\d+rem/);
  });

  it("is what the generator writes from design/tokens.json", () => {
    // A token added to tokens.json without regenerating the theme would otherwise reach the
    // app as a utility that does not exist. The script runs as a process (Vite gives its
    // module no file URL to resolve the root from), so a mismatch also leaves the file
    // regenerated, ready to commit.
    const file = resolve(stylesDir, "tailwind-theme.css");
    const before = readFileSync(file, "utf8");
    execFileSync(
      process.execPath,
      [resolve(stylesDir, "../../scripts/generate-tailwind-theme.mjs")],
      {
        stdio: "ignore",
      },
    );
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("rejects spacing steps outside the design scale", async () => {
    const css = await build(["p-7", "gap-0.5", "w-64", "p-4"]);
    expect(css).toContain(".p-4{");
    expect(css).not.toContain(".p-7{");
    expect(css).not.toContain(".gap-0\\.5{");
    expect(css).not.toContain(".w-64{");
  });
});
