// Composables over the registry: `useShortcut` attaches a handler for the life of a component,
// `useShortcutHint` gives the platform hint text, and `installShortcuts` wires one keydown
// listener on the window.

import { computed, onBeforeUnmount, onMounted, watch, type ComputedRef } from "vue";

import { shortcutRegistry, type ShortcutHandler } from "./registry";

/**
 * Runs `handler` while the calling component is mounted and, when `active` is given, while it
 * holds: an inactive binding leaves its key to the next handler and its palette row disabled.
 */
export function useShortcut(id: string, handler: ShortcutHandler, active?: () => boolean): void {
  let detach: (() => void) | undefined;
  let mounted = false;
  const sync = (): void => {
    const wanted = mounted && (active?.() ?? true);
    if (wanted && !detach) detach = shortcutRegistry().register(id, handler);
    else if (!wanted && detach) {
      detach();
      detach = undefined;
    }
  };
  onMounted(() => {
    mounted = true;
    sync();
  });
  if (active) watch(active, sync);
  onBeforeUnmount(() => {
    mounted = false;
    sync();
  });
}

/** The hint text (`Ctrl K`, `⌘K`) of a binding, for `Kbd` components. */
export function useShortcutHint(id: string): ComputedRef<string> {
  return computed(() => shortcutRegistry().hint(id));
}

/** Installs the global keydown dispatcher; returns the uninstall function. */
export function installShortcuts(
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  const listener = (event: KeyboardEvent) => {
    shortcutRegistry().dispatch(event);
  };
  target.addEventListener("keydown", listener as EventListener);
  return () => target.removeEventListener("keydown", listener as EventListener);
}
