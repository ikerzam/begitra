// The derivation of a theme's colour tokens from its palette (design/themes.json), shared by
// scripts/generate-themes.mjs and the token tests. A colour under its floor moves its HSL lightness
// away from the background until it passes, so a theme keeps its hues.

/** The floor of `--white` on the fills it is the text of: the destructive button's three and
 * the current branch's badge. */
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
 * `hex` lifted until its contrast reaches `floor` on every one of `backgrounds`, one HSL
 * lightness point at a time away from the first (lighter on a dark background, darker on a
 * light one); the colour itself when it already does.
 */
export function liftOn(hex, backgrounds, floor) {
  const passes = (candidate) => backgrounds.every((bg) => contrast(candidate, bg) >= floor);
  if (passes(hex)) return hex.toLowerCase();
  const hsl = toHsl(hex);
  const step = luminance(backgrounds[0]) < 0.5 ? 0.01 : -0.01;
  let l = hsl.l;
  let candidate = hex.toLowerCase();
  for (let i = 0; i < 100 && !passes(candidate); i += 1) {
    l = Math.max(0, Math.min(1, l + step));
    candidate = fromHsl({ ...hsl, l });
  }
  return candidate;
}

/**
 * A border lifted until it stands `floor` apart from every one of `backgrounds`, moving on
 * its own side of the first (a border darker than the background gets darker).
 */
export function liftBorder(hex, backgrounds, floor) {
  const passes = (candidate) => backgrounds.every((bg) => contrast(candidate, bg) >= floor);
  if (passes(hex)) return hex.toLowerCase();
  const hsl = toHsl(hex);
  const step = luminance(hex) < luminance(backgrounds[0]) ? -0.01 : 0.01;
  let l = hsl.l;
  let candidate = hex.toLowerCase();
  for (let i = 0; i < 100 && !passes(candidate); i += 1) {
    l = Math.max(0, Math.min(1, l + step));
    candidate = fromHsl({ ...hsl, l });
  }
  return candidate;
}

function toLab(hex) {
  const { r, g, b } = parseHex(hex);
  const linear = (value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [linear(r), linear(g), linear(b)];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return { L: 116 * f(y) - 16, a: 500 * (f(x) - f(y)), b: 200 * (f(y) - f(z)) };
}

/** The CIEDE2000 colour difference of two opaque colours. */
export function deltaE(hexA, hexB) {
  const p = toLab(hexA);
  const q = toLab(hexB);
  const rad = Math.PI / 180;
  const C1 = Math.hypot(p.a, p.b);
  const C2 = Math.hypot(q.a, q.b);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1 = (1 + G) * p.a;
  const a2 = (1 + G) * q.a;
  const c1 = Math.hypot(a1, p.b);
  const c2 = Math.hypot(a2, q.b);
  const hue = (a, b) => {
    if (a === 0 && b === 0) return 0;
    const h = Math.atan2(b, a) / rad;
    return h < 0 ? h + 360 : h;
  };
  const h1 = hue(a1, p.b);
  const h2 = hue(a2, q.b);
  const dL = q.L - p.L;
  const dC = c2 - c1;
  let dh = 0;
  if (c1 * c2 !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(c1 * c2) * Math.sin((dh / 2) * rad);
  const Lm = (p.L + q.L) / 2;
  const cm = (c1 + c2) / 2;
  let hm = h1 + h2;
  if (c1 * c2 !== 0) {
    if (Math.abs(h1 - h2) > 180) hm = h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2;
    else hm = (h1 + h2) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hm - 30) * rad) +
    0.24 * Math.cos(2 * hm * rad) +
    0.32 * Math.cos((3 * hm + 6) * rad) -
    0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(cm ** 7 / (cm ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const Sc = 1 + 0.045 * cm;
  const Sh = 1 + 0.015 * cm * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

/** The alpha byte of `hex` at `alpha` (0 to 1). */
function alphaByte(alpha) {
  return Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0");
}

/**
 * Contrast floors of the diff's inks: the text 4.5:1 on the changed rows and spans, the code's
 * colours 3:1 on the background, the rows and the spans (the floor of non-text marks; 4.5:1 would
 * turn most themes' comments into other colours), the `+` and `−` markers 4.5:1 on the background
 * and their row.
 */
export const TINT_FLOORS = { text: 4.5, code: 3, marker: 4.5 };
/** How far apart a lane must stay from the accent and from every other lane (CIEDE2000). */
export const LANE_DISTANCE = 11;

/**
 * The colour tokens of one palette, the colours the floors lifted (`{ token, from, to }`) and
 * the diff's alphas. `names` is the list of colour tokens every theme must define
 * (design/tokens.json).
 */
export function deriveTokens(palette, names) {
  const dark = palette.brightness === "dark";
  const bg = palette.bg.toLowerCase();
  const raised = palette.raised.toLowerCase();
  const surfaces = [bg, raised];
  const lifts = [];
  const tokens = new Map();
  /** Records `value` for `name`, noting a lift from `from`. */
  const put = (name, value, from = value) => {
    const final = value.toLowerCase();
    if (final !== from.toLowerCase())
      lifts.push({ token: name, from: from.toLowerCase(), to: final });
    tokens.set(name, final);
    return final;
  };

  put("--bg-app", bg);
  put("--bg-raised", raised);
  let text = put("--text", liftOn(palette.text, surfaces, 7), palette.text);
  const [hover, selected, active] = dark ? ["0f", "1a", "24"] : ["0a", "14", "1f"];
  put("--border", liftBorder(palette.border, surfaces, 1.15), palette.border);
  const strong = put(
    "--border-strong",
    liftBorder(palette.borderStrong, surfaces, 1.3),
    palette.borderStrong,
  );

  // Text roles keep their order: text over secondary over muted over disabled.
  const mutedFrom = palette.muted ?? mixToContrast(text, bg, bg, 4.6);
  const muted = put("--text-muted", liftOn(mutedFrom, surfaces, 4.5), mutedFrom);
  const secondaryFloor = Math.max(
    4.5,
    1.2 * Math.min(contrast(muted, bg), contrast(muted, raised)),
  );
  const secondaryFrom =
    palette.secondary ??
    mixToContrast(text, bg, bg, Math.max(secondaryFloor, Math.min(7, contrast(text, bg) * 0.62)));
  const secondary = put(
    "--text-secondary",
    liftOn(secondaryFrom, surfaces, secondaryFloor),
    secondaryFrom,
  );
  put("--text-disabled", mixToContrast(text, bg, bg, 2.2));

  const accent = put(
    "--accent",
    liftOn(palette.accent, [bg, raised, composite(withAlpha(text, selected), bg)], 3),
    palette.accent,
  );
  const accentText = put("--accent-text", liftOn(palette.accent, surfaces, 4.5), palette.accent);
  put("--focus-ring", accentText);

  const danger = put("--danger", liftOn(palette.red, surfaces, 4.5), palette.red);
  const dangerHover = put("--danger-hover", mix(danger, dark ? "#ffffff" : "#000000", 0.15));
  const dangerActive = put("--danger-active", mix(danger, "#000000", dark ? 0.15 : 0.3));

  // Syntax on the plain background first; the diff's tints below lift what they must.
  const kinds = ["keyword", "function", "type", "string", "number", "comment"];
  const syntax = new Map(kinds.map((kind) => [kind, liftOn(palette.syntax[kind], [bg], 3)]));

  // The diff's tints: the palette's green and red at the alphas, among 10–18% for the changed
  // row and 20–40% for the changed span over it (Begitra's own are 18% and 40%), that keep a
  // change visible (the row 1.1:1 on the background, the span 1.2:1 on its row) and leave the
  // least to lift in the code's colours (CIEDE2000 summed) to keep the text 4.5:1 and the
  // punctuation and syntax 3:1 on both; the larger alphas win a tie.
  const inks = [text, secondary, ...kinds.map((kind) => syntax.get(kind))];
  const floors = inks.map((_, index) => (index === 0 ? TINT_FLOORS.text : TINT_FLOORS.code));
  const tint = (hue, rowAlpha, spanAlpha) => {
    const row = composite(withAlpha(hue, alphaByte(rowAlpha)), bg);
    const span = composite(withAlpha(hue, alphaByte(spanAlpha)), row);
    return { row, span };
  };
  const cost = (surfaces) =>
    inks.reduce((sum, ink, index) => {
      const lifted = liftOn(ink, surfaces, floors[index]);
      return sum + (lifted === ink ? 0 : deltaE(ink, lifted));
    }, 0);
  const best = (hue) => {
    let chosen = { row: 0.1, span: 0.2, cost: Infinity };
    for (let r = 18; r >= 10; r -= 1) {
      for (let p = 40; p >= 20; p -= 2) {
        const { row, span } = tint(hue, r / 100, p / 100);
        if (contrast(row, bg) < 1.1 || contrast(span, row) < 1.2) continue;
        const total = cost([row, span]);
        if (total < chosen.cost - 1e-9) chosen = { row: r / 100, span: p / 100, cost: total };
      }
    }
    return chosen;
  };
  const addTint = best(palette.green);
  const delTint = best(palette.red);
  const addAlpha = addTint.row;
  const delAlpha = delTint.row;
  const addSpanAlpha = addTint.span;
  const delSpanAlpha = delTint.span;
  const { row: addRow, span: addSpan } = tint(palette.green, addAlpha, addSpanAlpha);
  const { row: delRow, span: delSpan } = tint(palette.red, delAlpha, delSpanAlpha);
  put("--diff-add-bg", withAlpha(palette.green, alphaByte(addAlpha)));
  put("--diff-add-emphasis", withAlpha(palette.green, alphaByte(addSpanAlpha)));
  put("--diff-del-bg", withAlpha(palette.red, alphaByte(delAlpha)));
  put("--diff-del-emphasis", withAlpha(palette.red, alphaByte(delSpanAlpha)));
  // The + and − markers sit on their row's tint.
  put("--diff-add-fg", liftOn(palette.green, [bg, addRow], TINT_FLOORS.marker), palette.green);
  put("--diff-del-fg", liftOn(palette.red, [bg, delRow], TINT_FLOORS.marker), palette.red);
  // The code keeps its floors on the tints and the spans too.
  const codeSurfaces = [bg, addRow, delRow, addSpan, delSpan];
  for (const kind of kinds) {
    const from = palette.syntax[kind];
    put(`--syntax-${kind}`, liftOn(syntax.get(kind), codeSurfaces, TINT_FLOORS.code), from);
  }
  const textOnSpans = liftOn(text, [addRow, delRow, addSpan, delSpan], TINT_FLOORS.text);
  if (textOnSpans !== text) {
    lifts.push({ token: "--text (spans)", from: text, to: textOnSpans });
    tokens.set("--text", textOnSpans);
    text = textOnSpans;
  }
  // The overlays and the primary button follow the final text.
  put("--bg-hover", withAlpha(text, hover));
  put("--bg-selected", withAlpha(text, selected));
  put("--bg-active", withAlpha(text, active));
  // The primary button is the text as a fill with the background as its label.
  const primaryFill = (limit) => {
    for (let hundredths = Math.round(limit * 100); hundredths >= 0; hundredths -= 1) {
      const fill = mix(text, bg, hundredths / 100);
      if (contrast(bg, fill) >= 4.5) return fill;
    }
    return text;
  };
  put("--btn-primary-hover", primaryFill(0.18));
  put("--btn-primary-active", primaryFill(0.28));
  const secondaryOnTints = liftOn(tokens.get("--text-secondary"), codeSurfaces, TINT_FLOORS.code);
  if (secondaryOnTints !== tokens.get("--text-secondary")) {
    lifts.push({
      token: "--text-secondary (tints)",
      from: tokens.get("--text-secondary"),
      to: secondaryOnTints,
    });
    tokens.set("--text-secondary", secondaryOnTints);
  }

  put("--warn", liftOn(palette.yellow, surfaces, 4.5), palette.yellow);
  put("--ok", liftOn(palette.green, surfaces, 4.5), palette.green);
  put("--info", liftOn(palette.blue, surfaces, 4.5), palette.blue);
  put("--reviewed", liftOn(palette.green, surfaces, 4.5), palette.green);
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
  lanes.forEach((lane, index) => put(`--lane-${index + 1}`, liftOn(lane, [bg], 3), lane));

  put("--ref-local", strong);
  const current = put("--ref-current", accent);
  put("--ref-remote", tokens.get("--lane-4"));
  put("--ref-tag", tokens.get("--lane-7"));
  put("--ref-head", text);
  put("--ref-stash", tokens.get("--lane-8"));

  // The text on the destructive button (at rest, hovered and pressed) and on the current
  // branch's badge: white, else the background, the first that reads 3:1 on all four; the
  // best of white, the background and black when neither does.
  const fills = [danger, dangerHover, dangerActive, current];
  const score = (candidate) => Math.min(...fills.map((fill) => contrast(candidate, fill)));
  const preferred = ["#ffffff", bg].find((candidate) => score(candidate) >= 3);
  const white =
    preferred ??
    ["#ffffff", bg, "#000000"].reduce((best, candidate) =>
      score(candidate) > score(best) ? candidate : best,
    );
  tokens.set("--white", white);

  const missing = names.filter((name) => !tokens.has(name));
  const extra = [...tokens.keys()].filter((name) => !names.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`${palette.id}: missing ${missing.join(", ")}; extra ${extra.join(", ")}`);
  }

  // Lanes stay apart from the accent and from one another.
  const clashes = [];
  const laneValues = lanes.map((_, index) => tokens.get(`--lane-${index + 1}`));
  laneValues.forEach((lane, index) => {
    if (deltaE(lane, accent) < LANE_DISTANCE) clashes.push(`lane ${index + 1} ~ accent`);
    laneValues.slice(index + 1).forEach((other, offset) => {
      if (deltaE(lane, other) < LANE_DISTANCE) {
        clashes.push(`lane ${index + 1} ~ lane ${index + offset + 2}`);
      }
    });
  });
  return {
    tokens: new Map(names.map((name) => [name, tokens.get(name)])),
    lifts,
    onFill: score(white),
    clashes,
    alphas: { add: addAlpha, del: delAlpha, addSpan: addSpanAlpha, delSpan: delSpanAlpha },
  };
}

const HEADER =
  "Generated by scripts/generate-themes.mjs from design/themes.json and design/tokens.json; do not edit.";

/**
 * themes.css: Begitra's own dark and light colours as attributes, whole (so either can be the
 * code theme inside any window), then one block per palette.
 */
export function buildCss(darkTokens, lightTokens, themes) {
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
    block('[data-theme="light"]', "light", lightTokens),
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
