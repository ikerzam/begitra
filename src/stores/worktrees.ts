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
import { arm } from "@/motion/motion";
import { baseName, sameFolder } from "@/shell/format";

import { isUnmergedDelete } from "./branches";
import { useCompareStore } from "./compare";
import { useIndexStore } from "./index";
import { useOperationsStore } from "./operations";
import { useProjectsStore } from "./projects";
import { useRepoStore } from "./repo";
import { useSettingsStore } from "./settings";
import { useShellStore } from "./shell";
import { useToastsStore } from "./toasts";

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
  /** The main worktree of a bare repository, which has no working tree to run git in. */
  bare: boolean;
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
  /** `branch`: the branch the removal deletes too, once the worktree is gone. */
  | { kind: "remove"; path: string; force: boolean; branch?: string | null }
  | { kind: "prune"; paths: string[] }
  | { kind: "lock"; path: string };

/**
 * What the add dialog starts from, when a branch's "New worktree…" opens it: an existing
 * branch, or a new branch from `start`, named `name` and tracking `start` when `track`.
 */
export type AddPreset =
  | { kind: "existing"; branch: string }
  | { kind: "new"; start: string; name: string; track: boolean };

export const useWorktreesStore = defineStore("worktrees", () => {
  const repo = useRepoStore();
  const index = useIndexStore();
  const settings = useSettingsStore();
  const toasts = useToastsStore();
  const shell = useShellStore();
  const compare = useCompareStore();
  const operations = useOperationsStore();

  const selectedPath = ref<string | null>(null);
  const loading = ref(false);
  /** The worktrees whose removal runs: their rows are busy and a second removal is refused. */
  const removing = ref<string[]>([]);
  /** The last failed write, shown in the banner until the next action. */
  const error = ref<AppError | null>(null);
  /** The path the failed write concerned, for the missing-folder banner. */
  const errorPath = ref<string | null>(null);
  const addOpen = ref(false);
  /** What the add dialog starts from; null for its defaults. */
  const addPreset = ref<AddPreset | null>(null);
  const prompt = ref<WorktreePrompt | null>(null);
  const aheadBehind = ref(new Map<string, { ahead: number; behind: number }>());
  /** Locks and unlocks asked and not yet read back: the rows show them before git answers. */
  const locking = ref(new Map<string, { locked: boolean; reason: string | null }>());
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
      const asked = locking.value.get(worktree.path);
      return {
        path: worktree.path,
        name: baseName(worktree.path),
        branch: worktree.branch,
        head: worktree.head,
        detached: worktree.detached,
        isMain: worktree.isMain,
        locked: asked ? asked.locked : worktree.locked,
        lockReason: asked ? asked.reason : worktree.lockReason,
        prunable: worktree.prunable,
        bare: worktree.bare,
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
  /** The failure concerns a worktree whose folder is gone. */
  const errorIsMissingFolder = computed(() => {
    const failed = error.value;
    const path = errorPath.value;
    if (!failed) return false;
    if (failed.code === "worktree.missing_folder") return true;
    return path !== null && rows.value.some((row) => row.path === path && row.prunable);
  });

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
    operations.start(opId, "operations.readingWorktrees", undefined, { background: true });
    try {
      await repo.loadWorktrees();
      if (mine !== serial) return;
    } finally {
      loading.value = false;
      operations.finish(opId);
    }
    await refreshRows(root, mine);
  }

  /**
   * Refreshes the rows' index entries and counts each against main. The entries' reads (a
   * status each, seconds on a large tree) are counted in the status bar as a background read,
   * since the dirty dots show only once they end.
   */
  async function refreshRows(root: string, mine: number): Promise<void> {
    const main = mainBranch.value;
    const counts = new Map<string, { ahead: number; behind: number }>();
    const linkedTrees = repo.worktrees.filter((worktree) => !worktree.isMain);
    const readOp = newOpId("worktree-states");
    let read = 0;
    if (linkedTrees.length > 0) {
      operations.start(readOp, "operations.checkingWorktrees", linkedTrees.length, {
        params: { n: String(linkedTrees.length) },
        background: true,
      });
    }
    const states = linkedTrees.map((worktree) =>
      index.refresh(worktree.path).finally(() => {
        read += 1;
        operations.progress(readOp, read);
        if (read === linkedTrees.length) operations.finish(readOp);
      }),
    );
    void Promise.allSettled(states);
    await Promise.all(
      linkedTrees.map(async (worktree) => {
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

  /**
   * Shows the worktree in the open project, which it joins first when it is not one of its
   * members (made outside the app, by hand or by an agent), as an added worktree does.
   */
  async function openAsContext(path: string): Promise<void> {
    const projects = useProjectsStore();
    const project = projects.active;
    if (!project) {
      await projects.openRepository(path);
      return;
    }
    if (!project.members.some((member) => sameFolder(member.path, path))) {
      await projects.join(path);
    }
    await projects.show(path);
  }

  /** The comparison of the main branch with the worktree. */
  function compareWithMain(path: string): void {
    const row = rows.value.find((entry) => entry.path === path);
    const main = mainBranch.value;
    const rev = row?.branch ?? row?.head;
    if (!row || !main || !rev) return;
    compare.open(
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
    error.value = new AppError("worktree.missing_folder", `the worktree folder ${path} is missing`);
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
      // The row shows from git's answer; the listing and the rows' figures follow.
      arm("worktrees");
      repo.patchWorktrees((listed) =>
        listed.some((worktree) => worktree.path === added.path) ? listed : [...listed, added],
      );
      selectedPath.value = added.path;
      // The new worktree joins the open project.
      void useProjectsStore().join(added.path);
      addOpen.value = false;
      addPreset.value = null;
      clearError();
      void load();
      // A new branch (`-b`) and the branch's worktree marker come with the refs.
      void repo.refreshRefs();
      // Away from the dashboard (a branch's "New worktree…"), the toast says where it went.
      if (shell.layoutMode !== "worktrees") {
        toasts.push({
          kind: "success",
          message: "",
          key: "worktrees.added",
          params: { folder: baseName(added.path) },
          actionKey: "worktrees.open",
          onAction: () => void openAsContext(added.path),
        });
      }
      return added.path;
    } catch (failed) {
      error.value = toAppError(failed);
      errorPath.value = request.path;
      // git keeps the worktree when only its post-checkout hook failed: the list shows it.
      void load();
      void repo.refreshRefs();
      return null;
    } finally {
      operations.finish(opId);
    }
  }

  /**
   * Removes a worktree, and then `branch` when given, in the same repository as soon as git
   * removed the worktree (git refuses to delete a branch a worktree holds). Without `force`,
   * git's refusal of a dirty worktree opens the second prompt ("Remove anyway"), which keeps
   * the branch asked.
   */
  async function remove(
    path: string,
    force: boolean,
    branch: string | null = null,
  ): Promise<boolean> {
    const root = repo.repo?.root;
    // A removal already running deletes the same folder: a second one would only fail.
    if (!root || removing.value.includes(path)) return false;
    prompt.value = null;
    clearError();
    // Where the branch is deleted, chosen before the list loses the worktree.
    const host = branch !== null ? hostFor(path, root) : null;
    const opId = newOpId("worktree-remove");
    removing.value = [...removing.value, path];
    operations.start(opId, "operations.removingWorktree", undefined, {
      params: { name: baseName(path) },
    });
    try {
      await ipc.worktreeRemove(root, path, force, opId);
    } catch (failed) {
      const appError = toAppError(failed);
      if (appError.code === "worktree.dirty" && !force) {
        prompt.value = { kind: "remove", path, force: true, branch };
        return false;
      }
      error.value = appError;
      errorPath.value = path;
      return false;
    } finally {
      removing.value = removing.value.filter((known) => known !== path);
      operations.finish(opId);
    }
    if (selectedPath.value === path) selectedPath.value = null;
    // The row leaves on git's answer, before the worktrees are read again.
    arm("worktrees");
    repo.patchWorktrees((listed) => listed.filter((worktree) => worktree.path !== path));
    gone([path]);
    if (branch !== null) await deleteBranchOf(root, host, path, branch);
    await load();
    return true;
  }

  /**
   * A worktree of the same repository that the removal of `path` leaves on disk, where its
   * branch can be deleted: the main one first (`git branch -d` without an upstream checks the
   * branch against HEAD there, so "merged" reads as merged into the main branch), else the open
   * one, else another; never a missing folder or a bare main worktree, which the engine does
   * not open (git itself could run there).
   */
  function hostFor(path: string, root: string): string | null {
    const others = rows.value.filter(
      (row) => !sameFolder(row.path, path) && !row.prunable && !row.bare,
    );
    const pick =
      others.find((row) => row.isMain) ??
      others.find((row) => sameFolder(row.path, root)) ??
      others[0];
    return pick?.path ?? null;
  }

  /**
   * The branch a removed worktree held, deleted with `git branch -d` in `host`, a worktree of
   * the repository the worktree was removed from (`root`), whichever is open now. Never `-D`:
   * with its worktree gone, an unmerged branch's commits would have no reflog left, so git's
   * refusal keeps the branch and the toast says why.
   */
  async function deleteBranchOf(
    root: string,
    host: string | null,
    path: string,
    branch: string,
  ): Promise<void> {
    const params = { folder: baseName(path), name: branch };
    if (host === null) {
      toasts.push({ kind: "info", message: "", key: "worktrees.removedBranchNoHost", params });
      return;
    }
    const opId = newOpId("branch-delete");
    operations.start(opId, "operations.deletingBranch");
    try {
      await ipc.branchDelete(host, branch, false, opId);
      if (repo.repo?.root === root) {
        repo.patchRefs({ kind: "delete", fullName: `refs/heads/${branch}` });
        void repo.refreshRefs();
      }
      toasts.push({ kind: "success", message: "", key: "worktrees.removedWithBranch", params });
    } catch (failure) {
      const refused = toAppError(failure);
      toasts.push(
        isUnmergedDelete(refused)
          ? { kind: "info", message: "", key: "worktrees.removedBranchKept", params }
          : {
              kind: "error",
              message: "",
              key: "worktrees.removedBranchFailed",
              params: { ...params, message: refused.message },
              output: refused.detail ?? refused.message,
            },
      );
    } finally {
      operations.finish(opId);
    }
  }

  /**
   * Worktrees whose folders git removed: their project members are flagged missing,
   * and their branches lose the worktree marker.
   */
  function gone(paths: string[]): void {
    void repo.refreshRefs();
    for (const path of paths) void index.refresh(path, false);
  }

  async function prune(): Promise<string[]> {
    const root = repo.repo?.root;
    if (!root) return [];
    prompt.value = null;
    let pruned: string[] = [];
    await run(null, async () => {
      pruned = await ipc.worktreePrune(root, newOpId("worktree-prune"));
    });
    if (pruned.length > 0) gone(pruned);
    return pruned;
  }

  async function lock(path: string, reason: string | null): Promise<boolean> {
    const root = repo.repo?.root;
    if (!root) return false;
    prompt.value = null;
    return asking(path, { locked: true, reason }, () =>
      run(path, async () => {
        await ipc.worktreeLock(root, path, reason, newOpId("worktree-lock"));
      }),
    );
  }

  async function unlock(path: string): Promise<boolean> {
    const root = repo.repo?.root;
    if (!root) return false;
    return asking(path, { locked: false, reason: null }, () =>
      run(path, async () => {
        await ipc.worktreeUnlock(root, path, newOpId("worktree-unlock"));
      }),
    );
  }

  /**
   * Shows the row's lock state `state` while `write` runs and the list is read again; a refusal
   * shows what git holds.
   */
  async function asking(
    path: string,
    state: { locked: boolean; reason: string | null },
    write: () => Promise<boolean>,
  ): Promise<boolean> {
    locking.value = new Map(locking.value).set(path, state);
    try {
      return await write();
    } finally {
      const left = new Map(locking.value);
      left.delete(path);
      locking.value = left;
    }
  }

  /** Asks before a removal; nothing while that worktree's removal already runs. */
  function askRemove(path: string): void {
    if (removing.value.includes(path)) return;
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

  function openAdd(preset: AddPreset | null = null): void {
    clearError();
    addPreset.value = preset;
    addOpen.value = true;
  }

  function closeAdd(): void {
    addOpen.value = false;
    addPreset.value = null;
    clearError();
  }

  /** What the list says of each worktree, to tell whether a listing changed a row. */
  function listed(): string {
    return repo.worktrees
      .map((w) => [w.path, w.branch, w.head, w.detached, w.locked, w.prunable].join("\u0000"))
      .join("\n");
  }

  /**
   * The watcher's kinds. A worktree came, went or changed (`worktrees`): the list follows,
   * and the dashboard reloads whole while it is up. Refs moved: a commit or a switch moves a
   * worktree's HEAD without touching the list's folders, so the list is read again, and the
   * dashboard refreshes its rows when one of them changed.
   */
  async function onRepoChanged(kinds: RepoChangeKind[]): Promise<void> {
    const changed = kinds.includes("worktrees");
    if (!changed && !kinds.includes("refs")) return;
    const root = repo.repo?.root;
    if (!root || repo.state.kind !== "ready") return;
    if (active.value && changed) return load();
    const before = listed();
    await repo.loadWorktrees();
    if (active.value && listed() !== before) {
      serial += 1;
      await refreshRows(root, serial);
    }
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
    removing,
    error,
    errorPath,
    errorIsMissingFolder,
    addOpen,
    addPreset,
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
