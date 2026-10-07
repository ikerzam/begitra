// Platform detection and shortcut rendering. Keys are written once in a canonical form
// (`mod+k`, `shift+mod+c`, `j`, `escape`): `mod` is ⌘ on macOS and Ctrl elsewhere, and hints
// render as `⌘K` / `⇧⌘C` on macOS and `Ctrl K` / `Ctrl Shift C` on Windows and Linux, so ⌘
// never appears where the font cannot draw it. `ctrl` is the Control key on every platform, for
// the chords macOS keeps off ⌘ (⌘Tab switches applications): on Windows and Linux it is `mod`.

export type Platform = "windows" | "macos" | "linux";

export function detectPlatform(
  nav: Pick<Navigator, "platform" | "userAgent"> = navigator,
): Platform {
  const hint = `${nav.platform} ${nav.userAgent}`.toLowerCase();
  if (hint.includes("mac")) return "macos";
  if (hint.includes("win")) return "windows";
  return "linux";
}

export type Modifier = "mod" | "ctrl" | "shift" | "alt";

const MODIFIERS: readonly string[] = ["mod", "ctrl", "shift", "alt"];

export interface ParsedKeys {
  modifiers: Set<Modifier>;
  key: string;
}

/** Parses `shift+mod+c` into its modifiers and its lower-case key. */
export function parseKeys(keys: string): ParsedKeys {
  const parts = keys
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const modifiers = new Set<Modifier>();
  let key = "";
  for (const part of parts) {
    if (MODIFIERS.includes(part)) modifiers.add(part as Modifier);
    else key = part;
  }
  return { modifiers, key };
}

/** Whether the Ctrl key is part of the chord on Windows and Linux, where `ctrl` is `mod`. */
function pressesCtrl(modifiers: Set<Modifier>): boolean {
  return modifiers.has("mod") || modifiers.has("ctrl");
}

const keyLabels: Record<string, { macos: string; other: string }> = {
  escape: { macos: "esc", other: "esc" },
  enter: { macos: "↵", other: "↵" },
  arrowup: { macos: "↑", other: "↑" },
  arrowdown: { macos: "↓", other: "↓" },
  arrowleft: { macos: "←", other: "←" },
  arrowright: { macos: "→", other: "→" },
  backspace: { macos: "⌫", other: "Backspace" },
  " ": { macos: "Space", other: "Space" },
  tab: { macos: "⇥", other: "Tab" },
};

/** Renders canonical keys as the hint text for `platform`. */
export function formatShortcut(keys: string, platform: Platform): string {
  const { modifiers, key } = parseKeys(keys);
  const label = keyLabels[key];
  if (platform === "macos") {
    // Apple's order: Control, Option, Shift, Command.
    const parts: string[] = [];
    if (modifiers.has("ctrl")) parts.push("⌃");
    if (modifiers.has("alt")) parts.push("⌥");
    if (modifiers.has("shift")) parts.push("⇧");
    if (modifiers.has("mod")) parts.push("⌘");
    parts.push(label ? label.macos : keyText(key, modifiers.size > 0));
    return parts.join("");
  }
  const parts: string[] = [];
  if (pressesCtrl(modifiers)) parts.push("Ctrl");
  if (modifiers.has("alt")) parts.push("Alt");
  if (modifiers.has("shift")) parts.push("Shift");
  parts.push(label ? label.other : keyText(key, modifiers.size > 0));
  return parts.join(" ");
}

function keyText(key: string, withModifiers: boolean): string {
  if (key.length === 1) return withModifiers ? key.toUpperCase() : key;
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** The keyboard event fields a shortcut match needs. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Keys another key stands for whatever Shift says: `=` and `+` share a key on US layouts
 * (Shift makes the `+`) and `+` has a key of its own on others, such as the Spanish one.
 */
const SAME_KEY: Record<string, readonly string[]> = { "=": ["=", "+"] };

/** Whether `event` is the chord described by `keys` on `platform`. */
export function matchesKeys(keys: string, event: KeyLike, platform: Platform): boolean {
  const { modifiers, key } = parseKeys(keys);
  if (platform === "macos") {
    if (event.metaKey !== modifiers.has("mod")) return false;
    if (event.ctrlKey !== modifiers.has("ctrl")) return false;
  } else {
    if (event.metaKey) return false;
    if (event.ctrlKey !== pressesCtrl(modifiers)) return false;
  }
  if (event.altKey !== modifiers.has("alt")) return false;
  const same = SAME_KEY[key];
  if (same && !modifiers.has("shift")) return same.includes(event.key);
  if (event.shiftKey !== modifiers.has("shift")) return false;
  return event.key.toLowerCase() === key;
}

/**
 * Whether two notations name the same chord on `platform`, whatever their order: on Windows and
 * Linux `ctrl+tab` and `mod+tab` press the same keys.
 */
export function sameKeys(a: string, b: string, platform: Platform): boolean {
  const chord = (keys: string) => {
    const { modifiers, key } = parseKeys(keys);
    const pressed = new Set<Modifier>(modifiers);
    if (platform !== "macos" && pressed.delete("ctrl")) pressed.add("mod");
    return [...pressed].sort().join("+") + "|" + key;
  };
  return chord(a) === chord(b);
}
