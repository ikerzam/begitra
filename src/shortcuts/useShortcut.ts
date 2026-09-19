// Composables over the registry: `useShortcut` attaches a handler for the life of a component,
// `useShortcutHint` gives the platform hint text, and `installShortcuts` wires one keydown
// listener on the window.

import { computed, onBeforeUnmount, onMounted, type ComputedRef } from "vue";

import { shortcutRegistry, type ShortcutHandler } from "./registry";

/** Runs `handler` while the calling component is mounted. */
export function useShortcut(id: string, handler: ShortcutHandler): void {
  let detach: (() => void) | undefined;
  onMounted(() => {
    detach = shortcutRegistry().register(id, handler);
  });
  onBeforeUnmount(() => {
    detach?.();
    detach = undefined;
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
