// The shortcut registry: the default bindings, the handlers that
// screens attach to them, and one keydown dispatcher. Bindings are keyed by a stable id so
// the palette, tooltips and the status bar can render the hint of any command.

import { detectPlatform, formatShortcut, matchesKeys, type Platform } from "./platform";

export interface ShortcutBinding {
  /** Stable id, also the i18n key suffix of its label (`shortcuts.<id>`). */
  id: string;
  /** Canonical keys, e.g. `mod+k`. */
  keys: string;
  /** Where the binding applies; `global` bindings fire everywhere. */
  scope: "global" | "list" | "review";
}

/** The default bindings. */
export const defaultBindings: readonly ShortcutBinding[] = [
  { id: "palette", keys: "mod+k", scope: "global" },
  { id: "graph-focus", keys: "mod+1", scope: "global" },
  { id: "review-focus", keys: "mod+2", scope: "global" },
  { id: "toggle-sidebar", keys: "mod+b", scope: "global" },
  { id: "diff-from", keys: "mod+d", scope: "global" },
  { id: "compare-with", keys: "shift+mod+c", scope: "global" },
  { id: "next-row", keys: "j", scope: "list" },
  { id: "previous-row", keys: "k", scope: "list" },
  { id: "next-hunk", keys: "n", scope: "review" },
  { id: "previous-hunk", keys: "p", scope: "review" },
  { id: "mark-reviewed", keys: "r", scope: "review" },
  { id: "next-file", keys: "j", scope: "review" },
  { id: "previous-file", keys: "k", scope: "review" },
  { id: "next-symbol", keys: "]", scope: "review" },
  { id: "previous-symbol", keys: "[", scope: "review" },
  { id: "open-terminal", keys: "mod+t", scope: "global" },
  { id: "open-editor", keys: "mod+e", scope: "global" },
  { id: "add-worktree", keys: "shift+mod+w", scope: "global" },
  { id: "settings", keys: "mod+,", scope: "global" },
];

export type ShortcutHandler = (event: KeyboardEvent) => void;

type TargetLike = { tagName?: string; type?: string; isContentEditable?: boolean } | null;

/** Input types that take no typed text: keys pressed on them are shortcuts, not input. */
const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/** Whether a key event comes from a text field, where plain-key shortcuts must not fire. */
export function isEditableTarget(target: TargetLike): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName?.toUpperCase();
  if (tag === "INPUT") return !NON_TEXT_INPUTS.has((target.type ?? "text").toLowerCase());
  return tag === "TEXTAREA" || tag === "SELECT";
}

export class ShortcutRegistry {
  readonly platform: Platform;
  private readonly bindings = new Map<string, ShortcutBinding>();
  private readonly handlers = new Map<string, ShortcutHandler[]>();

  constructor(platform: Platform = detectPlatform(), bindings = defaultBindings) {
    this.platform = platform;
    for (const binding of bindings) this.bindings.set(binding.id, binding);
  }

  /** Every binding, in definition order. */
  list(): ShortcutBinding[] {
    return [...this.bindings.values()];
  }

  binding(id: string): ShortcutBinding | undefined {
    return this.bindings.get(id);
  }

  /** The hint text of a binding on this platform, e.g. `Ctrl K`; empty for unknown ids. */
  hint(id: string): string {
    const binding = this.bindings.get(id);
    return binding ? formatShortcut(binding.keys, this.platform) : "";
  }

  /** Rebinds a command (the settings' overrides). */
  rebind(id: string, keys: string): void {
    const binding = this.bindings.get(id);
    if (binding) this.bindings.set(id, { ...binding, keys });
  }

  /** The default keys of a binding, whatever it is bound to now. */
  defaultKeys(id: string): string | undefined {
    return defaultBindings.find((binding) => binding.id === id)?.keys;
  }

  /** Attaches a handler; the last one attached wins. Returns the detach function. */
  register(id: string, handler: ShortcutHandler): () => void {
    const stack = this.handlers.get(id) ?? [];
    stack.push(handler);
    this.handlers.set(id, stack);
    return () => {
      const current = this.handlers.get(id) ?? [];
      const index = current.lastIndexOf(handler);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.handlers.delete(id);
    };
  }

  /** Whether some handler is attached to `id`. */
  isActive(id: string): boolean {
    return (this.handlers.get(id)?.length ?? 0) > 0;
  }

  /** Runs the handler of `id` as its key would (the palette's way in); false without one. */
  run(id: string): boolean {
    const stack = this.handlers.get(id);
    const handler = stack?.[stack.length - 1];
    if (!handler) return false;
    handler(new KeyboardEvent("keydown", { key: "" }));
    return true;
  }

  /**
   * Dispatches a keydown: the first binding whose keys match and that has a handler runs.
   * Plain-key bindings (no modifier) are skipped while a text field has focus. Returns whether
   * something handled the event (and called `preventDefault`).
   */
  dispatch(event: KeyboardEvent): boolean {
    // A list that already moved on this key (j/k in a focused tree) keeps the event.
    if (event.defaultPrevented) return false;
    const editable = isEditableTarget(event.target as TargetLike);
    for (const binding of this.bindings.values()) {
      const stack = this.handlers.get(binding.id);
      const handler = stack?.[stack.length - 1];
      if (!handler) continue;
      if (!matchesKeys(binding.keys, event, this.platform)) continue;
      if (editable && !binding.keys.includes("+")) continue;
      event.preventDefault();
      handler(event);
      return true;
    }
    return false;
  }
}

let shared: ShortcutRegistry | undefined;

/** The application registry (created on first use with the detected platform). */
export function shortcutRegistry(): ShortcutRegistry {
  shared ??= new ShortcutRegistry();
  return shared;
}

/** Replaces the shared registry; tests use it to pick a platform. */
export function setShortcutRegistry(registry: ShortcutRegistry | undefined): void {
  shared = registry;
}
