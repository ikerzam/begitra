// The Overview's keys: j/k and the arrows move the focus, Space selects the focused
// row, Ctrl+A (⌘A) selects every row, ↵ opens the focused repository, esc clears the selection.
// They listen on the table, so the Changes tab's keys and these never both apply.

import { computed, type Ref } from "vue";

import { matchesKeys } from "@/shortcuts/platform";
import { shortcutRegistry } from "@/shortcuts/registry";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import type { useOverviewStore } from "@/stores/overview";

export interface OverviewKeysOptions {
  overview: ReturnType<typeof useOverviewStore>;
  /** The table's element, whose rows carry `data-path`. */
  table: Ref<HTMLElement | null>;
  /** Opens the repository at `path` in graph focus. */
  open: (path: string) => void;
  /** Esc: what it does first (stopping a bulk operation); false to clear the selection. */
  onEscape?: () => boolean;
}

export function useOverviewKeys(options: OverviewKeysOptions) {
  const { overview } = options;
  const count = computed(() => overview.rows.length);
  const focused = computed({
    get: () => overview.focused,
    set: (index: number) => {
      overview.focused = index;
    },
  });
  const navigation = useListNavigation({
    count,
    selected: focused,
    rowElement: (index) => options.table.value?.querySelectorAll('[role="row"][data-path]')[index],
    onActivate: (index) => {
      const row = overview.rows[index];
      if (row && !row.missing) options.open(row.path);
    },
  });

  function onKeydown(event: KeyboardEvent): void {
    if (navigation.onKeydown(event)) return;
    const registry = shortcutRegistry();
    if (event.key === " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // A checkbox with the focus toggles itself.
      if (event.target instanceof HTMLInputElement) return;
      const row = overview.rows[overview.focused];
      if (!row) return;
      event.preventDefault();
      overview.toggle(row.path);
    } else if (matchesKeys("mod+a", event, registry.platform)) {
      event.preventDefault();
      overview.selectAll();
    } else if (event.key === "Escape") {
      if (options.onEscape?.()) {
        event.preventDefault();
        return;
      }
      if (overview.selection.size === 0) return;
      event.preventDefault();
      overview.clearSelection();
    }
  }

  return { onKeydown, focus: navigation.focus, select: navigation.select };
}
