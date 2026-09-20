// The worktrees dashboard: every worktree of the open repository with
// what the engine lists (path, branch, head, locked, prunable), what the index knows (dirty,
// last commit time), the ahead/behind against the main worktree's branch from one `compare`
// per linked worktree, and the four worktree writes through the git CLI, each confirmed once by
// the layout before it calls here.

import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import * as ipc from "@/ipc/commands";
import { AppError, toAppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type { RepoChangeKind, WorktreeAdd } from "@/ipc/schemas";
import { baseName } from "@/shell/format";

import { useCompareStore } from "./compare";
import { useIndexStore } from "./index";
import { useOperationsStore } from "./operations";
import { useRepoStore } from "./repo";
import { useSettingsStore } from "./settings";
import { useShellStore } from "./shell";

/** One row of the dashboard. */
export interface WorktreeRow {
  path: string;
  /** The folder name (the main worktree's too). */
  name: string;
  branch: string | null;
  head: string | null;
  detached: boolean;
  isMain: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  /** From the index; null when unknown or not refreshed yet. */
  dirty: boolean | null;
  lastCommitAt: number | null;
  /** The tip's subject when the loaded history lists it. */
  lastSubject: string | null;
  /** Against the main worktree's branch (the main worktree: against its upstream). */
  ahead: number | null;
  behind: number | null;
}

/** What the layout asks the user before a write. */
export type WorktreePrompt =
  | { kind: "remove"; path: string; force: boolean }
  | { kind: "prune"; paths: string[] }
  | { kind: "lock"; path: string };

export const useWorktreesStore = defineStore("worktrees", () => {
  const repo = useRepoStore();
  const index = useIndexStore();
  const settings = useSettingsStore();
  const shell = useShellStore();
  const compare = useCompareStore();
  const operations = useOperationsStore();

  const selectedPath = ref<string | null>(null);
  const loading = ref(false);
  /** The last failed write, shown in the banner until the next action. */
  const error = ref<AppError | null>(null);
  /** The path the failed write concerned, for the missing-folder banner. */
  const errorPath = ref<string | null>(null);
  const addOpen = ref(false);
  const prompt = ref<WorktreePrompt | null>(null);
  const aheadBehind = ref(new Map<string, { ahead: number; behind: number }>());
  let serial = 0;

  const active = computed(() => shell.layoutMode === "worktrees" && repo.state.kind === "ready");
  const mainBranch = computed(
    () => repo.worktrees.find((worktree) => worktree.isMain)?.branch ?? null,
  );
  const rows = computed<WorktreeRow[]>(() => {
    const root = repo.repo?.root;
    const entries = root ? [...index.worktreesOf(root), ...index.mains] : [];
    const summaryOf = (path: string) => entries.find((entry) => entry.path === path)?.summary;
    const current = repo.refs.find((ref) => ref.kind === "local-branch" && ref.isCurrent);
    return repo.worktrees.map((worktree) => {
      const summary = summaryOf(worktree.path);
      const tip = worktree.head
        ? repo.commits.find((commit) => commit.hash === worktree.head)
        : undefined;
      const counts = worktree.isMain
        ? { ahead: current?.ahead ?? null, behind: current?.behind ?? null }
        : (aheadBehind.value.get(worktree.path) ?? { ahead: null, behind: null });
      return {
        path: worktree.path,
        name: baseName(worktree.path),
        branch: worktree.branch,
        head: worktree.head,
        detached: worktree.detached,
        isMain: worktree.isMain,
        locked: worktree.locked,
        lockReason: worktree.lockReason,
        prunable: worktree.prunable,
        dirty: summary?.dirty ?? null,
        lastCommitAt: summary?.lastCommitAt ?? tip?.author.time ?? null,
        lastSubject: tip?.subject ?? null,
        ahead: counts.ahead,
        behind: counts.behind,
      };
    });
  });
  const linked = computed(() => rows.value.filter((row) => !row.isMain));
  const prunable = computed(() => rows.value.filter((row) => row.prunable).map((row) => row.path));
  const selected = computed(
    () => rows.value.find((row) => row.path === selectedPath.value) ?? null,
  );

  /** The folder new worktrees go under: the setting, or a sibling of the repository. */
  const worktreeFolder = computed(() => {
    const configured = settings.values.worktreeFolder;
    if (configured) return configured;
    const root = repo.repo?.root;
    if (!root) return "";
    const trimmed = root.replace(/[\\/]+$/, "");
    const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    const separator = trimmed.includes("\\") ? "\\" : "/";
    const parent = cut >= 0 ? trimmed.slice(0, cut) : trimmed;
    return `${parent}${separator}${baseName(trimmed)}.worktrees`;
  });

  /** The default path of a new worktree for `branch`, slashes as dashes. */
  function defaultPath(branch: string): string {
    const folder = worktreeFolder.value;
    if (!folder) return "";
    const separator = folder.includes("\\") ? "\\" : "/";
    return `${folder}${separator}${branch.replace(/[\\/]+/g, "-")}`;
  }

  /** Lists the worktrees, refreshes their index entries and counts each against main. */
  async function load(): Promise<void> {
    const root = repo.repo?.root;
    if (!root || repo.state.kind !== "ready") return;
    serial += 1;
    const mine = serial;
    loading.value = true;
    const opId = newOpId("worktrees");
    operations.start(opId, "operations.readingWorktrees");
    try {
      await repo.loadWorktrees();
      if (mine !== serial) return;
    } finally {
      loading.value = false;
      operations.finish(opId);
    }
    const main = mainBranch.value;
    const counts = new Map<string, { ahead: number; behind: number }>();
    await Promise.all(
      repo.worktrees
        .filter((worktree) => !worktree.isMain)
        .map(async (worktree) => {
          void index.refresh(worktree.path);
          const rev = worktree.branch ?? worktree.head;
          if (!main || !rev) return;
          try {
            const result = await ipc.compare(root, main, rev, newOpId("compare"));
            counts.set(worktree.path, { ahead: result.onlyInB, behind: result.onlyInA });
          } catch {
            // The row shows no counts.
          }
        }),
    );
    if (mine === serial) aheadBehind.value = counts;
  }

  function select(path: string | null): void {
    selectedPath.value = path;
  }

  /** Shows the dashboard. */
  async function show(): Promise<void> {
    await shell.setLayoutMode("worktrees");
  }

  /** Opens the worktree as the repository context. */
  async function openAsContext(path: string): Promise<void> {
    await index.open(path);
  }

  /** The comparison of the main branch with the worktree. */
  async function compareWithMain(path: string): Promise<void> {
    const row = rows.value.find((entry) => entry.path === path);
    const main = mainBranch.value;
    const rev = row?.branch ?? row?.head;
    if (!row || !main || !rev) return;
    await compare.open(
      { kind: "revision", rev: main, label: main },
      { kind: "worktree", rev, label: row.name },
    );
  }

  function clearError(): void {
    error.value = null;
    errorPath.value = null;
  }

  /** An action needed the worktree's folder, which is gone: the banner says so. */
  function reportMissing(path: string): void {
    error.value = new AppError(
      "worktree.missing_folder",
      `the worktree folder ${path} is missing`,
      `fatal: '${path}' is not a working tree\nhint: run 'git worktree prune' to remove stale entries`,
    );
    errorPath.value = path;
  }

  async function run(path: string | null, work: () => Promise<void>): Promise<boolean> {
    clearError();
    try {
      await work();
      await load();
      return true;
    } catch (failed) {
      error.value = toAppError(failed);
      errorPath.value = path;
      return false;
    }
  }

  /** Adds a worktree; resolves with the new row's path, or null when git refused. */
  async function add(request: WorktreeAdd): Promise<string | null> {
    const root = repo.repo?.root;
    if (!root) return null;
    const opId = newOpId("worktree-add");
    operations.start(opId, "operations.addingWorktree");
    try {
      const added = await ipc.worktreeAdd(root, request, opId);
      await load();
      selectedPath.value = added.path;
      addOpen.value = false;
      clearError();
      return added.path;
    } catch (failed) {
      error.value = toAppError(failed);
      errorPath.value = request.path;
      // git keeps the worktree when only its post-checkout hook failed: the list shows it.
      void load();
      return null;
    } finally {
      operations.finish(opId);
    }
  }

  /**
   * Removes a worktree. Without `force`, git's refusal of a dirty worktree opens the second
   * prompt ("Remove anyway") instead of failing.
   */
  async function remove(path: string, force: boolean): Promise<boolean> {
    const root = repo.repo?.root;
    if (!root) return false;
    prompt.value = null;
    clearError();
    try {
      await ipc.worktreeRemove(root, path, force, newOpId("worktree-remove"));
    } catch (failed) {
      const appError = toAppError(failed);
      if (appError.code === "worktree.dirty" && !force) {
        prompt.value = { kind: "remove", path, force: true };
        return false;
      }
      error.value = appError;
      errorPath.value = path;
      return false;
    }
    if (selectedPath.value === path) selectedPath.value = null;
    await load();
    return true;
  }

  async function prune(): Promise<string[]> {
    const root = repo.repo?.root;
    if (!root) return [];
    prompt.value = null;
    let pruned: string[] = [];
    await run(null, async () => {
      pruned = await ipc.worktreePrune(root, newOpId("worktree-prune"));
    });
    return pruned;
  }

  async function lock(path: string, reason: string | null): Promise<boolean> {
    const root = repo.repo?.root;
    if (!root) return false;
    prompt.value = null;
    return run(path, async () => {
      await ipc.worktreeLock(root, path, reason, newOpId("worktree-lock"));
    });
  }

  async function unlock(path: string): Promise<boolean> {
    const root = repo.repo?.root;
    if (!root) return false;
    return run(path, async () => {
      await ipc.worktreeUnlock(root, path, newOpId("worktree-unlock"));
    });
  }

  function askRemove(path: string): void {
    prompt.value = { kind: "remove", path, force: false };
  }

  function askPrune(): void {
    if (prunable.value.length > 0) prompt.value = { kind: "prune", paths: prunable.value };
  }

  function askLock(path: string): void {
    prompt.value = { kind: "lock", path };
  }

  function dismissPrompt(): void {
    prompt.value = null;
  }

  function openAdd(): void {
    clearError();
    addOpen.value = true;
  }

  function closeAdd(): void {
    addOpen.value = false;
  }

  /** The watcher saw the worktrees change (a terminal added or removed one). */
  function onRepoChanged(kinds: RepoChangeKind[]): void {
    if (active.value && kinds.includes("worktrees")) void load();
  }

  // Entering the dashboard (or the repository becoming ready while it is up) loads it.
  watch(
    active,
    (on) => {
      if (on) void load();
    },
    { immediate: true },
  );

  // Another repository: the selection and the errors go.
  watch(
    () => repo.repo?.root,
    () => {
      selectedPath.value = null;
      aheadBehind.value = new Map();
      prompt.value = null;
      addOpen.value = false;
      clearError();
    },
  );

  return {
    rows,
    linked,
    prunable,
    selected,
    selectedPath,
    loading,
    error,
    errorPath,
    addOpen,
    prompt,
    mainBranch,
    worktreeFolder,
    defaultPath,
    load,
    select,
    show,
    openAsContext,
    compareWithMain,
    add,
    remove,
    prune,
    lock,
    unlock,
    askRemove,
    askPrune,
    askLock,
    dismissPrompt,
    openAdd,
    closeAdd,
    clearError,
    reportMissing,
    onRepoChanged,
  };
});
