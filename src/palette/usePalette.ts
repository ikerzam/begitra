// Palette state: the query, the filtered rows grouped as Recent, Commands and Repos, the
// keyboard cursor, and running a row. The palette renders whatever this returns; it knows
// nothing of the DOM beyond a keydown handler.

import { computed, ref, watch, type Component, type ComputedRef, type Ref } from "vue";

import type { PaletteCommand } from "./commands";

export const RECENT_LIMIT = 3;

export type PaletteSection = "recent" | "commands" | "projects" | "repos";

/** An indexed repository the Repos section can open. */
export interface PaletteRepo {
  path: string;
  name: string;
  /** The muted context column (the path, abbreviated). */
  context: string;
  /** Listed while the query is empty (pinned and recent repositories). */
  featured: boolean;
  icon?: Component;
  run: () => void | Promise<void>;
}

export interface PaletteRow {
  command: PaletteCommand;
  /** Translated label, used for filtering and display. */
  label: string;
  /** Muted text before the shortcut hint. */
  context?: string;
  icon?: Component;
  section: PaletteSection;
}

export interface PaletteOptions {
  commands: Ref<PaletteCommand[]> | ComputedRef<PaletteCommand[]>;
  /** Resolves a label key to text in the current locale. */
  translate: (key: string) => string;
  onClose: () => void;
  /** Ids of the last run commands, most recent first; the caller may hand in a persisted ref. */
  recents?: Ref<string[]>;
  /** The repositories of the Repos section. */
  repos?: Ref<PaletteRepo[]> | ComputedRef<PaletteRepo[]>;
  /** The projects of the Projects section, listed whole while the query is empty. */
  projects?: Ref<PaletteRepo[]> | ComputedRef<PaletteRepo[]>;
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

/** The id of the row that opens `path`; not a command, so it never lands under Recent. */
export function repoRowId(path: string): string {
  return `repo:${path}`;
}

/** The id of the row that opens the project at `key` (`project:<id>`). */
export function projectRowId(key: string): string {
  return `project:${key}`;
}

export function usePalette(options: PaletteOptions): Palette {
  const query = ref("");
  const cursor = ref(0);
  const recents = options.recents ?? ref<string[]>([]);

  const rows = computed<PaletteRow[]>(() => {
    const all = options.commands.value
      .filter((command) => command.enabled())
      .map((command) => ({ command, label: options.translate(command.labelKey) }));
    const matching = all.filter((entry) => matchesQuery(entry.label, query.value));
    const recentRows: PaletteRow[] = [];
    const empty = query.value.trim() === "";
    if (empty) {
      for (const id of recents.value) {
        const entry = matching.find((candidate) => candidate.command.id === id);
        if (entry) recentRows.push({ ...entry, section: "recent" });
      }
    }
    const rest = matching
      .filter((entry) => !recentRows.some((row) => row.command.id === entry.command.id))
      .map((entry): PaletteRow => ({ ...entry, section: "commands" }));
    const rowsOf = (
      entries: PaletteRepo[],
      section: "projects" | "repos",
      id: (key: string) => string,
    ): PaletteRow[] =>
      entries
        .filter((repo) =>
          empty ? repo.featured : matchesQuery(`${repo.name} ${repo.context}`, query.value),
        )
        .map((repo) => ({
          command: { id: id(repo.path), labelKey: "", enabled: () => true, run: repo.run },
          label: repo.name,
          context: repo.context,
          icon: repo.icon,
          section,
        }));
    const projectRows = rowsOf(options.projects?.value ?? [], "projects", projectRowId);
    const repoRows = rowsOf(options.repos?.value ?? [], "repos", repoRowId);
    return [...recentRows, ...rest, ...projectRows, ...repoRows];
  });

  const isEmpty = computed(() => rows.value.length === 0);

  // Typing changes the rows, so the cursor goes back to the first one before the next key.
  watch(
    query,
    () => {
      cursor.value = 0;
    },
    { flush: "sync" },
  );

  function clampCursor(): void {
    const count = rows.value.length;
    cursor.value = count === 0 ? 0 : Math.min(Math.max(cursor.value, 0), count - 1);
  }

  async function run(row: PaletteRow): Promise<void> {
    if (row.section !== "repos" && row.section !== "projects") {
      recents.value = [
        row.command.id,
        ...recents.value.filter((id) => id !== row.command.id),
      ].slice(0, RECENT_LIMIT);
    }
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
