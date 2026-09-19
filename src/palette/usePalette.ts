// Palette state: the query, the filtered rows grouped as Recent and Commands, the keyboard
// cursor, and running a row. The palette renders whatever this returns; it knows nothing of
// the DOM beyond a keydown handler.

import { computed, ref, type ComputedRef, type Ref } from "vue";

import type { PaletteCommand } from "./commands";

export const RECENT_LIMIT = 3;

export interface PaletteRow {
  command: PaletteCommand;
  /** Translated label, used for filtering and display. */
  label: string;
  section: "recent" | "commands";
}

export interface PaletteOptions {
  commands: Ref<PaletteCommand[]> | ComputedRef<PaletteCommand[]>;
  /** Resolves a label key to text in the current locale. */
  translate: (key: string) => string;
  onClose: () => void;
}

export interface Palette {
  query: Ref<string>;
  cursor: Ref<number>;
  rows: ComputedRef<PaletteRow[]>;
  isEmpty: ComputedRef<boolean>;
  recents: Ref<string[]>;
  onKeydown: (event: KeyboardEvent) => boolean;
  run: (row: PaletteRow) => Promise<void>;
  reset: () => void;
}

/** Whether every word of the query appears in the label, in order, ignoring case. */
export function matchesQuery(label: string, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = label.toLowerCase();
  let from = 0;
  for (const word of words) {
    const at = haystack.indexOf(word, from);
    if (at < 0) return false;
    from = at + word.length;
  }
  return true;
}

export function usePalette(options: PaletteOptions): Palette {
  const query = ref("");
  const cursor = ref(0);
  const recents = ref<string[]>([]);

  const rows = computed<PaletteRow[]>(() => {
    const all = options.commands.value
      .filter((command) => command.enabled())
      .map((command) => ({ command, label: options.translate(command.labelKey) }));
    const matching = all.filter((entry) => matchesQuery(entry.label, query.value));
    const recentRows: PaletteRow[] = [];
    if (query.value.trim() === "") {
      for (const id of recents.value) {
        const entry = matching.find((candidate) => candidate.command.id === id);
        if (entry) recentRows.push({ ...entry, section: "recent" });
      }
    }
    const rest = matching
      .filter((entry) => !recentRows.some((row) => row.command.id === entry.command.id))
      .map((entry): PaletteRow => ({ ...entry, section: "commands" }));
    return [...recentRows, ...rest];
  });

  const isEmpty = computed(() => rows.value.length === 0);

  function clampCursor(): void {
    const count = rows.value.length;
    cursor.value = count === 0 ? 0 : Math.min(Math.max(cursor.value, 0), count - 1);
  }

  async function run(row: PaletteRow): Promise<void> {
    recents.value = [row.command.id, ...recents.value.filter((id) => id !== row.command.id)].slice(
      0,
      RECENT_LIMIT,
    );
    options.onClose();
    reset();
    await row.command.run();
  }

  function reset(): void {
    query.value = "";
    cursor.value = 0;
  }

  function onKeydown(event: KeyboardEvent): boolean {
    switch (event.key) {
      case "ArrowDown":
        cursor.value += 1;
        clampCursor();
        break;
      case "ArrowUp":
        cursor.value -= 1;
        clampCursor();
        break;
      case "Enter": {
        clampCursor();
        const row = rows.value[cursor.value];
        if (row) void run(row);
        break;
      }
      case "Escape":
        options.onClose();
        reset();
        break;
      default:
        return false;
    }
    event.preventDefault();
    return true;
  }

  return { query, cursor, rows, isEmpty, recents, onKeydown, run, reset };
}
