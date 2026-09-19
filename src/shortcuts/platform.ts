// Platform detection and shortcut rendering. Keys are written once in a canonical form
// (`mod+k`, `shift+mod+c`, `j`, `escape`): `mod` is ⌘ on macOS and Ctrl elsewhere, and hints
// render as `⌘K` / `⇧⌘C` on macOS and `Ctrl K` / `Ctrl Shift C` on Windows and Linux, so ⌘
// never appears where the font cannot draw it.

export type Platform = "windows" | "macos" | "linux";

export function detectPlatform(
  nav: Pick<Navigator, "platform" | "userAgent"> = navigator,
): Platform {
  const hint = `${nav.platform} ${nav.userAgent}`.toLowerCase();
  if (hint.includes("mac")) return "macos";
  if (hint.includes("win")) return "windows";
  return "linux";
}

export type Modifier = "mod" | "shift" | "alt";

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
    if (part === "mod" || part === "shift" || part === "alt") modifiers.add(part);
    else key = part;
  }
  return { modifiers, key };
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
    const parts: string[] = [];
    if (modifiers.has("alt")) parts.push("⌥");
    if (modifiers.has("shift")) parts.push("⇧");
    if (modifiers.has("mod")) parts.push("⌘");
    parts.push(label ? label.macos : keyText(key, modifiers.size > 0));
    return parts.join("");
  }
  const parts: string[] = [];
  if (modifiers.has("mod")) parts.push("Ctrl");
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

/** Whether `event` is the chord described by `keys` on `platform`. */
export function matchesKeys(keys: string, event: KeyLike, platform: Platform): boolean {
  const { modifiers, key } = parseKeys(keys);
  const mod = platform === "macos" ? event.metaKey : event.ctrlKey;
  const otherMod = platform === "macos" ? event.ctrlKey : event.metaKey;
  if (otherMod) return false;
  if (mod !== modifiers.has("mod")) return false;
  if (event.shiftKey !== modifiers.has("shift")) return false;
  if (event.altKey !== modifiers.has("alt")) return false;
  return event.key.toLowerCase() === key;
}
