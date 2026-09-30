// The Overview of the open project: one row per member in its order, each worktree under its
// repository when both are members, filled from the index at once; each member's summary is read
// again once the rows are known, when it joins the project and on refresh, four at a time (the
// scan's summary workers are four too) and without a status of the working tree, whose changed
// files the member's lists count; a member whose summary cannot be read keeps its row with the
// reason. Above the rows, the branches the members are on, most common first. The selection
// (Space, Ctrl+A) is what the bulk actions act on, every row when empty.

import { defineStore } from "pinia";
import { computed, reactive, ref, shallowReactive, watch } from "vue";

import type { AppError } from "@/ipc/errors";
import type { OperationState, RepoSummary } from "@/ipc/schemas";
import { laneIndex } from "@/components/lanes";

import { newOpId } from "@/ipc/invoke";

import { useFolderStore } from "./folder";
import { useIndexStore } from "./index";
import { useOperationsStore } from "./operations";
import { useProjectsStore } from "./projects";

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
  /** A worktree listed under its repository (the row draws the connector). */
  nested: boolean;
  /** Found by its folder's scan: only a scan of the folder takes it out of the project. */
  own: boolean;
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

/**
 * The branches of `branches` (one per member, null for none), most common first, then by name,
 * each with its lane: the Overview's groups, and the dots of any list of members.
 */
export function branchGroups(branches: readonly (string | null)[]): BranchGroup[] {
  const counts = new Map<string, number>();
  for (const branch of branches) {
    if (branch === null) continue;
    counts.set(branch, (counts.get(branch) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a, left], [b, right]) => right - left || a.localeCompare(b))
    .map(([branch, count], at) => ({ branch, count, lane: laneIndex(at + 1) }));
}

export const useOverviewStore = defineStore("overview", () => {
  const folder = useFolderStore();
  const index = useIndexStore();
  const operations = useOperationsStore();
  const projects = useProjectsStore();

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
        nested: member.nested,
        own: member.origin === "folder",
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

  /**
   * Whether the rows are the project's: the index and the projects read, the list holding it.
   * Until then the Overview shows skeleton rows and reads nothing.
   */
  const rowsKnown = computed(
    () => index.read && projects.loaded && projects.loadError === null && folder.project !== null,
  );

  /** The branches of the present members, most common first, then by name. */
  const groups = computed<BranchGroup[]>(() =>
    branchGroups(rows.value.map((row) => (row.missing ? null : row.branch))),
  );
  const lanes = computed(() => new Map(groups.value.map((group) => [group.branch, group.lane])));

  // --- Reads ----------------------------------------------------------------------------------

  const queue: string[] = [];
  const running = ref(0);
  const waiting = ref(0);
  let reading = false;
  /** The members read since the view showed, its project changed or it was refreshed. */
  const read = new Set<string>();
  /** The status bar's "Reading N repositories" for the reads of one refresh. */
  let readOp: string | null = null;
  let readTotal = 0;
  let readDone = 0;

  function counted(): void {
    if (!readOp) return;
    readDone += 1;
    if (running.value === 0 && queue.length === 0) {
      operations.finish(readOp);
      readOp = null;
    } else {
      operations.progress(readOp, readDone, readTotal);
    }
  }

  function track(added: number): void {
    if (added === 0) return;
    if (!readOp) {
      readOp = newOpId("reading");
      readTotal = 0;
      readDone = 0;
      readTotal += added;
      operations.start(readOp, "operations.readingRepositories", readTotal, {
        params: { n: String(readTotal) },
        background: true,
      });
    } else {
      readTotal += added;
      operations.setParams(readOp, { n: String(readTotal) });
      operations.progress(readOp, readDone, readTotal);
    }
  }
  /** Summaries still to read or being read, for the status bar's line. */
  const readsLeft = computed(() => running.value + waiting.value);

  function pump(): void {
    while (reading && running.value < READS_AT_ONCE && queue.length > 0) {
      const path = queue.shift();
      waiting.value = queue.length;
      if (path === undefined) return;
      running.value += 1;
      // HEAD, the upstream and its counts, the operation, the fetch and the tip, without the
      // status: the member's lists give its changed files, and a status of a 50,000-file tree
      // costs seconds where the rest costs milliseconds.
      void index
        .refresh(path, false)
        .then((failed) => {
          if (failed === null || failed.code === "repo.not_found") errors.delete(path);
          else errors.set(path, failed);
        })
        .finally(() => {
          running.value -= 1;
          pump();
          counted();
        });
    }
  }

  /**
   * Reads the summary of every present member not read yet, four at a time, in the project's
   * order: all of them once the rows are known, then the ones that join the project.
   */
  function readNew(): void {
    if (!rowsKnown.value) return;
    reading = true;
    let added = 0;
    for (const row of rows.value) {
      if (row.missing || read.has(row.path) || queue.includes(row.path)) continue;
      read.add(row.path);
      queue.push(row.path);
      added += 1;
    }
    waiting.value = queue.length;
    track(added);
    pump();
  }

  /** Reads every present member's summary again (the refresh button). */
  function refresh(): void {
    read.clear();
    readNew();
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
    read.clear();
    queue.length = 0;
    waiting.value = 0;
    if (readOp) operations.finish(readOp);
    readOp = null;
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

  // Another project's rows: the selection, the reasons and the focus were the old one's.
  watch(
    () => folder.source,
    () => {
      selection.clear();
      errors.clear();
      read.clear();
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
    rowsKnown,
    readsLeft,
    readNew,
    refresh,
    refreshOne,
    stop,
    toggle,
    selectAll,
    clearSelection,
  };
});
