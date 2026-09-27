// The Overview of the project view: one row per member of the view's source in its
// order, filled from the index at once and read again when the view shows and on refresh, four
// at a time (the scan's summary workers are four too); a member whose summary cannot be read
// keeps its row with the reason. Above the rows, the branches the members are on, most common
// first. The selection (Space, Ctrl+A) is what the bulk actions act on, every row when empty.

import { defineStore } from "pinia";
import { computed, reactive, ref, shallowReactive, watch } from "vue";

import type { AppError } from "@/ipc/errors";
import type { OperationState, RepoSummary } from "@/ipc/schemas";
import { laneIndex } from "@/components/lanes";
import { sameFolder } from "@/shell/format";

import { useFolderStore } from "./folder";
import { useIndexStore } from "./index";
import { useRepoStore } from "./repo";

/** Summaries read at once. */
export const READS_AT_ONCE = 4;

/** A member as its row shows it. */
export interface OverviewRow {
  path: string;
  name: string;
  /** No index entry, or its folder is gone. */
  missing: boolean;
  /** A linked worktree (the row carries the worktree icon). */
  worktree: boolean;
  /** For a worktree, the root of its repository. */
  mainPath: string | null;
  branch: string | null;
  detached: boolean;
  upstream: RepoSummary["upstream"];
  ahead: number | null;
  behind: number | null;
  /** The index's dirty flag; null when unknown. */
  dirty: boolean | null;
  /** Changed files from the member's lists; null until they are read. */
  changed: number | null;
  operation: OperationState | null;
  lastCommitAt: number | null;
  lastCommitSubject: string | null;
  fetchedAt: number | null;
  /** Why the last read of its summary failed; null when it did not. */
  error: AppError | null;
}

/** A branch some members are on, with how many and its lane colour. */
export interface BranchGroup {
  branch: string;
  count: number;
  lane: number;
}

export const useOverviewStore = defineStore("overview", () => {
  const folder = useFolderStore();
  const index = useIndexStore();
  const repo = useRepoStore();

  const errors = shallowReactive(new Map<string, AppError>());
  const selection = reactive(new Set<string>());
  /** The focused row, -1 for none. */
  const focused = ref(-1);

  const rows = computed<OverviewRow[]>(() =>
    folder.listed.map((member) => {
      const entry = member.entry;
      const summary = entry?.summary;
      const view = entry && !member.missing ? folder.viewOf(entry.path) : null;
      return {
        path: member.path,
        name: member.name,
        missing: member.missing,
        worktree: entry?.kind === "worktree",
        mainPath: entry?.parentPath ?? null,
        branch: summary?.currentBranch ?? null,
        detached: summary?.detached ?? false,
        upstream: summary?.upstream ?? null,
        ahead: summary?.ahead ?? null,
        behind: summary?.behind ?? null,
        dirty: summary?.dirty ?? null,
        changed: view?.counts?.changed ?? null,
        operation: summary?.operation ?? null,
        lastCommitAt: summary?.lastCommitAt ?? null,
        lastCommitSubject: summary?.lastCommitSubject ?? null,
        fetchedAt: summary?.fetchedAt ?? null,
        error: errors.get(member.path) ?? null,
      };
    }),
  );

  /** The branches of the present members, most common first, then by name. */
  const groups = computed<BranchGroup[]>(() => {
    const counts = new Map<string, number>();
    for (const row of rows.value) {
      if (row.missing || row.branch === null) continue;
      counts.set(row.branch, (counts.get(row.branch) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([a, left], [b, right]) => right - left || a.localeCompare(b))
      .map(([branch, count], at) => ({ branch, count, lane: laneIndex(at + 1) }));
  });
  const lanes = computed(() => new Map(groups.value.map((group) => [group.branch, group.lane])));

  // --- Reads ----------------------------------------------------------------------------------

  const queue: string[] = [];
  const running = ref(0);
  const waiting = ref(0);
  let reading = false;
  /** Summaries still to read or being read, for the status bar's line. */
  const readsLeft = computed(() => running.value + waiting.value);

  function isOpen(path: string): boolean {
    const open = repo.repo?.root;
    return open !== undefined && sameFolder(open, path);
  }

  function pump(): void {
    while (reading && running.value < READS_AT_ONCE && queue.length > 0) {
      const path = queue.shift();
      waiting.value = queue.length;
      if (path === undefined) return;
      running.value += 1;
      // The open repository's dirty flag is left alone while it is open (see the index store).
      void index
        .refresh(path, !isOpen(path))
        .then((failed) => {
          if (failed === null || failed.code === "repo.not_found") errors.delete(path);
          else errors.set(path, failed);
        })
        .finally(() => {
          running.value -= 1;
          pump();
        });
    }
  }

  /** Reads every present member's summary again, four at a time, in the source's order. */
  function refresh(): void {
    reading = true;
    for (const row of rows.value) {
      if (row.missing || queue.includes(row.path)) continue;
      queue.push(row.path);
    }
    waiting.value = queue.length;
    pump();
  }

  /** Reads one member's summary again (after a bulk operation), before the others waiting. */
  function refreshOne(path: string): void {
    reading = true;
    const at = queue.indexOf(path);
    if (at >= 0) queue.splice(at, 1);
    queue.unshift(path);
    waiting.value = queue.length;
    pump();
  }

  /** The view left: the reads not started are dropped. */
  function stop(): void {
    reading = false;
    queue.length = 0;
    waiting.value = 0;
  }

  // --- Selection and focus --------------------------------------------------------------------

  function toggle(path: string): void {
    if (selection.has(path)) selection.delete(path);
    else selection.add(path);
  }

  /** Selects every row; with every row selected already, selects none. */
  function selectAll(): void {
    const all = rows.value.map((row) => row.path);
    if (all.length > 0 && all.every((path) => selection.has(path))) selection.clear();
    else for (const path of all) selection.add(path);
  }

  function clearSelection(): void {
    selection.clear();
  }

  /** What the bulk actions act on: the selected rows, or every row when none is selected. */
  const targets = computed(() => {
    const chosen = rows.value.filter((row) => selection.has(row.path));
    return chosen.length > 0 ? chosen : rows.value;
  });

  // Another source's rows: the selection, the reasons and the focus were the old one's.
  watch(
    () => JSON.stringify(folder.source),
    () => {
      selection.clear();
      errors.clear();
      focused.value = -1;
    },
  );
  // A member removed from the project leaves the selection.
  watch(
    () => rows.value.map((row) => row.path).join("\n"),
    () => {
      const listed = new Set(rows.value.map((row) => row.path));
      for (const path of [...selection]) if (!listed.has(path)) selection.delete(path);
      focused.value = Math.min(focused.value, rows.value.length - 1);
    },
  );

  return {
    rows,
    groups,
    lanes,
    selection,
    focused,
    targets,
    readsLeft,
    refresh,
    refreshOne,
    stop,
    toggle,
    selectAll,
    clearSelection,
  };
});
