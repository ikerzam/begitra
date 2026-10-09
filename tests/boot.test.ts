import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const page = readFileSync(resolve(root, "index.html"), "utf8");
const screen = readFileSync(resolve(root, "public/boot.css"), "utf8");
const tokensCss = readFileSync(resolve(root, "src/styles/tokens.css"), "utf8");
const mainCss = readFileSync(resolve(root, "src/styles/main.css"), "utf8");
const brandIcon = readFileSync(resolve(root, "design/brand/begitra-icon.svg"), "utf8");

/** The drawing inside an `<svg>`, its gradient's id aside and its markup's spacing ignored. */
function drawing(svg: string, gradient: string): string {
  const inner = svg.slice(svg.indexOf(">", svg.indexOf("<svg")) + 1, svg.lastIndexOf("</svg>"));
  return inner
    .replaceAll(gradient, "GRADIENT")
    .replace(/\s*\/>/g, "/>")
    .replace(/\s+/g, " ")
    .replace(/> </g, "><")
    .trim();
}

const config = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8")) as {
  app: { windows: { label?: string; create?: boolean; backgroundColor?: string }[] };
};

/** The dark theme's own background, `--bg-app` under `:root`. */
const darkBackground = /:root\s*\{[^}]*--bg-app:\s*(#[0-9a-f]{6})/i.exec(tokensCss)?.[1];

describe("the start-up screen", () => {
  it("is part of the page, beside the app's root, styled before the body paints", () => {
    const head = page.slice(0, page.indexOf("<body>"));
    expect(head).toContain('<link rel="stylesheet" href="/boot.css" />');
    // Nothing inline for the content security policy to hash, and no script before the app's.
    expect(page).not.toContain("<style");
    expect(page.match(/<script/g)).toHaveLength(1);
    const body = page.slice(page.indexOf("<body>"), page.indexOf('<div id="app"></div>'));
    expect(body).toContain('<div class="boot" aria-hidden="true">');
    // Its own size too, should the stylesheet not load.
    expect(body).toMatch(/<svg [^>]*width="96" height="96"/);
  });

  it("draws the app icon as the brand file does", () => {
    const inline = page.slice(page.indexOf("<svg"), page.indexOf("</svg>") + "</svg>".length);
    expect(drawing(inline, "boot-ground")).toBe(drawing(brandIcon, "ground"));
  });

  it("lets the window's background show until the app applies its theme", () => {
    // The window takes the body's background once a theme applies.
    expect(mainCss).toMatch(/body \{[^}]*background: var\(--bg-app\);/);
    const box = /\.boot\s*\{([^}]*)\}/.exec(screen)?.[1] ?? "";
    expect(box).not.toMatch(/background/);
    expect(screen).toMatch(/html:not\(\[data-theme\]\) body\s*\{\s*background: transparent;\s*\}/);
    // The tokens' dark scheme would give the canvas the webview's dark base meanwhile.
    expect(tokensCss).toMatch(/:root\s*\{[^}]*color-scheme: dark;/);
    expect(screen).toMatch(/html:not\(\[data-theme\]\)\s*\{\s*color-scheme: normal;\s*\}/);
  });

  it("leaves the main window to the app, on the dark background by default", () => {
    expect(darkBackground).toBeDefined();
    const main = config.app.windows.find((window) => (window.label ?? "main") === "main");
    expect(main?.create).toBe(false);
    expect(main?.backgroundColor).toBe(darkBackground);
  });
});
