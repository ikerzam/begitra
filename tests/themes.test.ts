import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  composite,
  contrast,
  deltaE,
  deriveTokens,
  FIND_DISTANCE,
  LANE_DISTANCE,
  lift,
  liftBorder,
  liftOn,
  mix,
  mixToContrast,
  ON_FILL_FLOOR,
  TINT_FLOORS,
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

/** A token of a block, which every block defines. */
function token(tokens: Map<string, string>, name: string): string {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`no ${name}`);
  return value;
}

/**
 * The find's highlights keep their text (`--text`, which draws a match) readable on the plain
 * background, the changed rows and a picked row (they take a span's place), and still show.
 */
function expectFindFloors(id: string, tokens: Map<string, string>): void {
  const bg = token(tokens, "--bg-app");
  const surfaces = [
    bg,
    composite(token(tokens, "--diff-add-bg"), bg),
    composite(token(tokens, "--diff-del-bg"), bg),
    composite(token(tokens, "--bg-selected"), bg),
  ];
  for (const name of ["--find-match", "--find-current"]) {
    for (const surface of surfaces) {
      const lit = composite(token(tokens, name), surface);
      expect(
        contrast(token(tokens, "--text"), lit),
        `${id} text on ${name}`,
      ).toBeGreaterThanOrEqual(TINT_FLOORS.text);
    }
    expect(
      deltaE(composite(token(tokens, name), bg), bg),
      `${id} ${name} shows`,
    ).toBeGreaterThanOrEqual(FIND_DISTANCE);
  }
}

const TEXT_ON_SURFACES = [
  ["--text", 7],
  ["--text-secondary", 4.5],
  ["--text-muted", 4.5],
  ["--accent-text", 4.5],
  ["--danger", 4.5],
  ["--warn", 4.5],
  ["--ok", 4.5],
  ["--info", 4.5],
  ["--reviewed", 4.5],
] as const;
const CODE = [
  "--text-secondary",
  "--syntax-keyword",
  "--syntax-function",
  "--syntax-type",
  "--syntax-string",
  "--syntax-number",
  "--syntax-comment",
];

describe("theme derivation", () => {
  it("measures contrast and colour difference as WCAG and CIEDE2000 do", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    // A colour with alpha is measured over the background it sits on.
    expect(contrast("#00000000", "#ffffff")).toBeCloseTo(1, 5);
    expect(deltaE("#61afef", "#61afef")).toBe(0);
    // Red and green are as far apart as two colours get.
    expect(deltaE("#ff0000", "#00ff00")).toBeGreaterThan(80);
  });

  it("lifts a colour to its floor in its own hue, away from the background", () => {
    // Ayu Light's functions: darker on a light background.
    const onLight = lift("#eba400", "#fcfcfc", 3);
    expect(contrast(onLight, "#fcfcfc")).toBeGreaterThanOrEqual(3);
    expect(contrast(onLight, "#fcfcfc")).toBeLessThan(3.2);
    // One Dark's comments: lighter on a dark background.
    expect(contrast(lift("#5c6370", "#282c34", 3), "#282c34")).toBeGreaterThanOrEqual(3);
    // A colour already over its floor stays as it is.
    expect(lift("#98c379", "#282c34", 3)).toBe("#98c379");
    // On several surfaces at once.
    const both = liftOn("#7f848e", ["#282c34", "#21252b"], 4.5);
    expect(contrast(both, "#282c34")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(both, "#21252b")).toBeGreaterThanOrEqual(4.5);
  });

  it("moves a border on its own side of the background until it shows", () => {
    // Tokyo Night's own border sits 1.05:1 on its background and gets darker.
    const border = liftBorder("#15161e", ["#1a1b26", "#16161e"], 1.15);
    expect(contrast(border, "#1a1b26")).toBeGreaterThanOrEqual(1.15);
    expect(contrast(border, "#16161e")).toBeGreaterThanOrEqual(1.15);
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
    const { tokens, lifts, clashes } = deriveTokens(oneDark, names);
    expect([...tokens.keys()]).toEqual(names);
    expect(tokens.get("--bg-app")).toBe("#282c34");
    // A lifted colour stays close to its palette's: the keyword is still One Dark's purple.
    expect(deltaE(tokens.get("--syntax-keyword") ?? "", "#c678dd")).toBeLessThan(10);
    // The comment colour is under 3:1 in the original and is lifted.
    expect(lifts.map((l) => l.token)).toContain("--syntax-comment");
    expect(clashes).toEqual([]);
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

  it("gives Begitra's own dark and light colours, whole, to their attributes", () => {
    // Either can be the code theme inside any window, so neither may inherit a token.
    const dark = block("dark");
    const light = block("light");
    for (const [name, values] of Object.entries(tokensJson.colors)) {
      expect(dark.get(name), name).toBe(values.dark.toLowerCase());
      expect(light.get(name), name).toBe(values.light.toLowerCase());
    }
    // Begitra's own colours meet the find's floors too, which the palettes' derivation keeps.
    expectFindFloors("dark", dark);
    expectFindFloors("light", light);
  });

  it.each(palettes.map((palette) => [palette.id, palette] as const))(
    "%s defines every colour token and meets its floors",
    (id, palette) => {
      const tokens = block(id);
      expect([...tokens.keys()].sort()).toEqual([...names].sort());
      const bg = token(tokens, "--bg-app");
      const raised = token(tokens, "--bg-raised");
      expect(bg).toBe(palette.bg.toLowerCase());
      expect(themesCss).toContain(`[data-theme="${id}"] {\n  color-scheme: ${palette.brightness};`);

      // Text on both surfaces.
      for (const [name, floor] of TEXT_ON_SURFACES) {
        for (const surface of [bg, raised]) {
          expect(contrast(token(tokens, name), surface), `${id} ${name}`).toBeGreaterThanOrEqual(
            floor,
          );
        }
      }
      // The text roles keep their order.
      const on = (name: string) => contrast(token(tokens, name), bg);
      expect(on("--text")).toBeGreaterThan(on("--text-secondary"));
      expect(on("--text-secondary")).toBeGreaterThan(on("--text-muted"));
      expect(on("--text-muted")).toBeGreaterThan(on("--text-disabled"));
      // The hairlines show on both surfaces.
      for (const name of ["--border", "--border-strong"]) {
        for (const surface of [bg, raised]) {
          expect(contrast(token(tokens, name), surface), `${id} ${name}`).toBeGreaterThanOrEqual(
            1.15,
          );
        }
      }
      // The code on the plain background, the changed rows and the changed spans.
      const addRow = composite(token(tokens, "--diff-add-bg"), bg);
      const delRow = composite(token(tokens, "--diff-del-bg"), bg);
      const addSpan = composite(token(tokens, "--diff-add-emphasis"), addRow);
      const delSpan = composite(token(tokens, "--diff-del-emphasis"), delRow);
      for (const surface of [bg, addRow, delRow, addSpan, delSpan]) {
        expect(contrast(token(tokens, "--text"), surface), `${id} text`).toBeGreaterThanOrEqual(
          TINT_FLOORS.text,
        );
        for (const name of CODE) {
          expect(contrast(token(tokens, name), surface), `${id} ${name}`).toBeGreaterThanOrEqual(
            TINT_FLOORS.code,
          );
        }
      }
      // A change still shows, and its markers read on its row.
      expect(contrast(addRow, bg)).toBeGreaterThanOrEqual(1.1);
      expect(contrast(addSpan, addRow)).toBeGreaterThanOrEqual(1.2);
      expect(contrast(token(tokens, "--diff-add-fg"), addRow)).toBeGreaterThanOrEqual(
        TINT_FLOORS.marker,
      );
      expect(contrast(token(tokens, "--diff-del-fg"), delRow)).toBeGreaterThanOrEqual(
        TINT_FLOORS.marker,
      );
      expectFindFloors(id, tokens);
      // The accent shows as a bar, on a selected row too.
      const accent = token(tokens, "--accent");
      for (const surface of [bg, raised, composite(token(tokens, "--bg-selected"), bg)]) {
        expect(contrast(accent, surface), `${id} accent`).toBeGreaterThanOrEqual(3);
      }
      // The destructive button's and the current badge's text, on each of their fills.
      const white = token(tokens, "--white");
      for (const fill of ["--danger", "--danger-hover", "--danger-active", "--ref-current"]) {
        expect(
          contrast(white, token(tokens, fill)),
          `${id} --white on ${fill}`,
        ).toBeGreaterThanOrEqual(ON_FILL_FLOOR);
      }
      // Lanes read as dots and stay apart from the accent and from each other.
      const lanes = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => token(tokens, `--lane-${n}`));
      lanes.forEach((lane, index) => {
        expect(contrast(lane, bg), `${id} lane ${index + 1}`).toBeGreaterThanOrEqual(3);
        expect(deltaE(lane, accent), `${id} lane ${index + 1} ~ accent`).toBeGreaterThanOrEqual(
          LANE_DISTANCE,
        );
        lanes.slice(index + 1).forEach((other, offset) => {
          expect(
            deltaE(lane, other),
            `${id} lanes ${index + 1}, ${index + offset + 2}`,
          ).toBeGreaterThanOrEqual(LANE_DISTANCE);
        });
      });
    },
  );
});
