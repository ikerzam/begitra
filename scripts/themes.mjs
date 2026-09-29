// The derivation of a theme's colour tokens from its palette (design/themes.json), shared by
// scripts/generate-themes.mjs and the token tests.

/** Contrast floors on the theme's `--bg-app`, by token. */
export const FLOORS = {
  "--text": 7,
  "--text-secondary": 4.5,
  "--text-muted": 4.5,
  "--accent": 3,
  "--accent-text": 4.5,
  "--focus-ring": 4.5,
  "--danger": 4.5,
  "--warn": 4.5,
  "--ok": 4.5,
  "--info": 4.5,
  "--reviewed": 4.5,
  "--diff-add-fg": 4.5,
  "--diff-del-fg": 4.5,
  "--syntax-keyword": 3,
  "--syntax-function": 3,
  "--syntax-type": 3,
  "--syntax-string": 3,
  "--syntax-number": 3,
  "--syntax-comment": 3,
  "--lane-1": 3,
  "--lane-2": 3,
  "--lane-3": 3,
  "--lane-4": 3,
  "--lane-5": 3,
  "--lane-6": 3,
  "--lane-7": 3,
  "--lane-8": 3,
  "--ref-current": 3,
  "--ref-remote": 3,
  "--ref-tag": 3,
  "--ref-stash": 3,
};

/** The floor of `--white` on `--danger` and on `--ref-current`, the fills it is the text of. */
export const ON_FILL_FLOOR = 3;

/** `#RGB`, `#RRGGBB` or `#RRGGBBAA` as channels 0 to 255 and an alpha 0 to 1. */
export function parseHex(hex) {
  const text = hex.replace("#", "");
  const full =
    text.length === 3
      ? text
          .split("")
          .map((c) => c + c)
          .join("")
      : text;
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) throw new Error(`not a colour: ${hex}`);
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
  };
}

const byte = (value) =>
  Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, "0");

/** Lower-case `#rrggbb`, or `#rrggbbaa` below full opacity. */
export function toHex({ r, g, b, a = 1 }) {
  return `#${byte(r)}${byte(g)}${byte(b)}${a < 1 ? byte(a * 255) : ""}`;
}

/** `hex` over the opaque `under`. */
export function composite(hex, under) {
  const top = parseHex(hex);
  const base = parseHex(under);
  const mixed = (key) => top[key] * top.a + base[key] * (1 - top.a);
  return toHex({ r: mixed("r"), g: mixed("g"), b: mixed("b") });
}

/** WCAG relative luminance of an opaque colour. */
export function luminance(hex) {
  const { r, g, b } = parseHex(hex);
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio of `hex` (over `bg` when it carries alpha) against the opaque `bg`. */
export function contrast(hex, bg) {
  const a = luminance(composite(hex, bg));
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** `a` mixed with `b` by `t` (0 is `a`, 1 is `b`) in sRGB, opaque. */
export function mix(a, b, t) {
  const x = parseHex(a);
  const y = parseHex(b);
  const channel = (key) => x[key] + (y[key] - x[key]) * t;
  return toHex({ r: channel("r"), g: channel("g"), b: channel("b") });
}

function toHsl(hex) {
  const { r, g, b } = parseHex(hex);
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return { h: h / 6, s, l };
}

function fromHsl({ h, s, l }) {
  if (s === 0) return toHex({ r: l * 255, g: l * 255, b: l * 255 });
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return toHex({ r: hue(h + 1 / 3) * 255, g: hue(h) * 255, b: hue(h - 1 / 3) * 255 });
}

/**
 * `hex` with its HSL lightness moved away from `bg` one point at a time (lighter on a dark
 * background, darker on a light one) until its contrast on `bg` reaches `floor`; the colour
 * itself when it already does.
 */
export function lift(hex, bg, floor) {
  if (contrast(hex, bg) >= floor) return hex.toLowerCase();
  const hsl = toHsl(hex);
  const step = luminance(bg) < 0.5 ? 0.01 : -0.01;
  let l = hsl.l;
  let candidate = hex.toLowerCase();
  for (let i = 0; i < 100 && contrast(candidate, bg) < floor; i += 1) {
    l = Math.max(0, Math.min(1, l + step));
    candidate = fromHsl({ ...hsl, l });
  }
  return candidate;
}

/**
 * The colour between `from` and `toward` closest to `toward` whose contrast on `bg` is still
 * at least `target`; `from` when even it is under.
 */
export function mixToContrast(from, toward, bg, target) {
  if (contrast(from, bg) < target) return from.toLowerCase();
  let low = 0;
  let high = 1;
  for (let i = 0; i < 30; i += 1) {
    const middle = (low + high) / 2;
    if (contrast(mix(from, toward, middle), bg) >= target) low = middle;
    else high = middle;
  }
  return mix(from, toward, low);
}

/** `hex` (opaque) with the alpha byte `alpha` (two hex digits). */
export function withAlpha(hex, alpha) {
  return `${toHex(parseHex(hex))}${alpha}`.toLowerCase();
}

/**
 * The colour tokens of one palette, and the colours the floors lifted (`{ token, from, to }`).
 * `names` is the list of colour tokens every theme must define (design/tokens.json).
 */
export function deriveTokens(palette, names) {
  const dark = palette.brightness === "dark";
  const bg = palette.bg;
  const lifts = [];
  const tokens = new Map();
  const put = (name, value) => {
    const floor = FLOORS[name];
    const final = floor === undefined ? value.toLowerCase() : lift(value, bg, floor);
    if (final !== value.toLowerCase())
      lifts.push({ token: name, from: value.toLowerCase(), to: final });
    tokens.set(name, final);
    return final;
  };

  put("--bg-app", bg);
  put("--bg-raised", palette.raised);
  const [hover, selected, active] = dark ? ["0f", "1a", "24"] : ["0a", "14", "1f"];
  const text = put("--text", palette.text);
  put("--bg-hover", withAlpha(text, hover));
  put("--bg-selected", withAlpha(text, selected));
  put("--bg-active", withAlpha(text, active));
  put("--border", palette.border);
  put("--border-strong", palette.borderStrong);

  const textContrast = contrast(text, bg);
  const secondaryTarget = Math.max(4.5, Math.min(7, textContrast * 0.62));
  put("--text-secondary", palette.secondary ?? mixToContrast(text, bg, bg, secondaryTarget));
  put("--text-muted", palette.muted ?? mixToContrast(text, bg, bg, 4.6));
  put("--text-disabled", mixToContrast(text, bg, bg, 2.2));

  const accent = put("--accent", palette.accent);
  const accentText = put("--accent-text", palette.accent);
  put("--focus-ring", accentText);
  put("--btn-primary-hover", mix(text, bg, 0.18));
  put("--btn-primary-active", mix(text, bg, 0.28));

  const danger = put("--danger", palette.red);
  put("--danger-hover", mix(danger, dark ? "#ffffff" : "#000000", 0.15));
  put("--danger-active", mix(danger, "#000000", dark ? 0.15 : 0.3));

  put("--diff-add-bg", withAlpha(palette.green, "2e"));
  put("--diff-add-fg", palette.green);
  put("--diff-add-emphasis", withAlpha(palette.green, "66"));
  put("--diff-del-bg", withAlpha(palette.red, "2e"));
  put("--diff-del-fg", palette.red);
  put("--diff-del-emphasis", withAlpha(palette.red, "66"));

  for (const kind of ["keyword", "function", "type", "string", "number", "comment"]) {
    put(`--syntax-${kind}`, palette.syntax[kind]);
  }

  put("--warn", palette.yellow);
  put("--ok", palette.green);
  put("--info", palette.blue);
  put("--reviewed", palette.green);
  put("--shadow-color", dark ? "#00000099" : "#00000033");

  const lanes = palette.lanes ?? [
    palette.orange,
    palette.green,
    palette.blue,
    palette.purple,
    palette.pink,
    palette.cyan,
    palette.yellow,
    palette.gray,
  ];
  if (lanes.length !== 8) throw new Error(`${palette.id}: eight lanes, not ${lanes.length}`);
  lanes.forEach((lane, index) => put(`--lane-${index + 1}`, lane));

  put("--ref-local", palette.borderStrong);
  const current = put("--ref-current", accent);
  put("--ref-remote", tokens.get("--lane-4"));
  put("--ref-tag", palette.yellow);
  put("--ref-head", text);
  put("--ref-stash", tokens.get("--lane-8"));

  // The text of the destructive button and of the current branch's badge.
  const candidates = ["#ffffff", bg.toLowerCase(), "#000000"];
  const score = (candidate) => Math.min(contrast(candidate, danger), contrast(candidate, current));
  const white = candidates.reduce((best, candidate) =>
    score(candidate) > score(best) ? candidate : best,
  );
  tokens.set("--white", white);

  const missing = names.filter((name) => !tokens.has(name));
  const extra = [...tokens.keys()].filter((name) => !names.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`${palette.id}: missing ${missing.join(", ")}; extra ${extra.join(", ")}`);
  }
  return {
    tokens: new Map(names.map((name) => [name, tokens.get(name)])),
    lifts,
    onFill: score(white),
  };
}

const HEADER =
  "Generated by scripts/generate-themes.mjs from design/themes.json and design/tokens.json; do not edit.";

/** themes.css: Begitra's dark colours as an attribute (for a dark code theme inside a light window), then one block per palette. */
export function buildCss(darkTokens, themes) {
  const block = (selector, scheme, tokens) =>
    [
      `${selector} {`,
      `  color-scheme: ${scheme};`,
      "",
      ...[...tokens].map(([name, value]) => `  ${name}: ${value};`),
      "}",
    ].join("\n");
  const blocks = [
    `/* ${HEADER} */`,
    block('[data-theme="dark"]', "dark", darkTokens),
    ...themes.map(({ palette, tokens }) =>
      block(`[data-theme="${palette.id}"]`, palette.brightness, tokens),
    ),
  ];
  return `${blocks.join("\n\n")}\n`;
}

/** themes.ts: the ids, names and brightness the settings and the select share. */
export function buildTs(palettes) {
  const sorted = [...palettes].sort((a, b) => a.name.localeCompare(b.name, "en"));
  const rows = sorted.map(
    (p) => `  { id: "${p.id}", name: "${p.name}", brightness: "${p.brightness}" },`,
  );
  return [
    `// ${HEADER}`,
    "",
    "/** A theme beyond Begitra's own dark and light, by name. */",
    "export interface PaletteTheme {",
    "  readonly id: string;",
    "  readonly name: string;",
    '  readonly brightness: "dark" | "light";',
    "}",
    "",
    "export const PALETTE_THEMES = [",
    ...rows,
    "] as const satisfies readonly PaletteTheme[];",
    "",
    "/** The id of a theme beyond Begitra's own. */",
    'export type PaletteThemeId = (typeof PALETTE_THEMES)[number]["id"];',
    "",
  ].join("\n");
}
