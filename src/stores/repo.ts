// The open repository: its description, refs, the commit pages streamed from the walk, the
// selected commit and its change set. Everything comes from the IPC client; the store keeps
// only the pages it has received and asks for more on demand.

import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";

import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type {
  CommitNode,
  DiffPage,
  FileChange,
  Ref as GitRef,
  Repo,
  WalkFilter,
  WalkPage,
  WalkScope,
  Worktree,
} from "@/ipc/schemas";
import type { StreamHandle } from "@/ipc/stream";
import { arm, type MotionList } from "@/motion/motion";

import { useOperationsStore } from "./operations";

export type RepoState =
  | { kind: "empty" }
  | { kind: "opening"; path: string }
  | { kind: "ready" }
  | { kind: "error"; path: string; error: AppError };

export interface WalkPosition {
  walkId: string;
  nextIndex: number;
  done: boolean;
  /** Pages below this index were loaded by an earlier walk and are skipped on arrival. */
  skipBefore: number;
}

export interface Detail {
  hash: string;
  files: FileChange[];
  additions: number;
  deletions: number;
  totalFiles: number;
  loading: boolean;
  error?: AppError;
}

/** Pages requested per walk call; 4 pages of 500 keep the first paint fast and memory bounded. */
export const PAGES_PER_REQUEST = 4;

/** The commit HEAD points at as the refs listing tells; null while HEAD is unborn. */
export function headTarget(refs: GitRef[]): string | null {
  return refs.find((entry) => entry.kind === "head")?.target ?? null;
}

/**
 * HEAD's branch and whether it is detached, as the refs listing tells: the local branch
 * marked current, else detached when HEAD resolves; null for an unborn branch, which lists
 * no ref (the name the open read stays).
 */
export function headState(
  refs: GitRef[],
): { currentBranch: string | null; detached: boolean } | null {
  const branch = refs.find((entry) => entry.kind === "local-branch" && entry.isCurrent);
  if (branch) return { currentBranch: branch.name, detached: false };
  if (refs.some((entry) => entry.kind === "head")) return { currentBranch: null, detached: true };
  return null;
}

/** Where the tips point: every ref but the stash entries, as `fullName=target` sorted. */
export function tipsSignature(refs: GitRef[]): string {
  return refs
    .filter((entry) => entry.kind !== "stash")
    .map((entry) => `${entry.fullName}=${entry.target}`)
    .sort()
    .join("|");
}

/** A commit's change set that takes longer than this names itself in the status bar. */
export const SLOW_DIFF_MS = 150;

/** What git answered, shown before the refs are listed again (`patchRefs`). */
export type RefPatch =
  | { kind: "delete"; fullName: string }
  | { kind: "rename"; fullName: string; name: string; newFullName: string }
  | { kind: "drop-stash"; hash: string };

/** `n` of `stash@{n}`, or null for another name. */
function stashNumber(name: string): number | null {
  const match = /^stash@\{(\d+)\}$/.exec(name);
  return match ? Number(match[1]) : null;
}

export const useRepoStore = defineStore("repo", () => {
  const operations = useOperationsStore();

  const state = ref<RepoState>({ kind: "empty" });
  const repo = ref<Repo | null>(null);
  const refs = ref<GitRef[]>([]);
  /** Whether the refs of the open repository have arrived (they load after the first page). */
  const refsLoaded = ref(false);
  /** The failure of the last refs listing; the refs shown stay as they were. */
  const refsError = ref<AppError | null>(null);
  // Commits are appended by the thousand and never edited in place: a shallow ref avoids a
  // reactive proxy per commit.
  const commits = shallowRef<CommitNode[]>([]);
  const walk = ref<WalkPosition | null>(null);
  /** What the current walk lists; the graph store sets both through `restartWalk`. */
  const walkScope = ref<WalkScope>({ kind: "all" });
  const walkFilter = ref<WalkFilter | undefined>(undefined);
  const streaming = ref(false);
  const walkError = ref<AppError | null>(null);
  const selectedIndex = ref(-1);
  const detail = ref<Detail | null>(null);
  const worktrees = ref<Worktree[]>([]);
  const worktreesError = ref<AppError | null>(null);

  let walkHandle: StreamHandle | null = null;
  let diffHandle: StreamHandle | null = null;
  let generation = 0;
  /** Number of the latest diff request; older streams are ignored whatever commit they hold. */
  let diffRequest = 0;
  /** Whether the current walk was already restarted once after the backend lost it. */
  let walkRecovered = false;
  /** Number of the current walk; pages and endings of an earlier walk are ignored. */
  let walkSerial = 0;
  /** Hash to select again once a restarted walk lists it. */
  let pendingSelection: string | null = null;
  /** When the walk was last listed again, for the watcher (see `recentlyRestarted`). */
  let lastRestartAt = 0;
  /** A reloaded walk's first page replaces the rows kept meanwhile (`reloadWalk`). */
  const replacing = ref(false);
  /** The list a listing of the refs asked to animate, armed when the next one is stored. */
  let armNext: MotionList | null = null;
  /** Bumped by each listing of the refs: only the one started last may store what it read. */
  let refsSerial = 0;
  /** The same for the listings of the worktrees. */
  let worktreesSerial = 0;

  const selectedCommit = computed<CommitNode | undefined>(() => commits.value[selectedIndex.value]);
  const canLoadMore = computed(
    () =>
      state.value.kind === "ready" && walk.value !== null && !walk.value.done && !streaming.value,
  );
  const currentBranch = computed(() =>
    refs.value.find((r) => r.kind === "local-branch" && r.isCurrent),
  );

  function reset(): void {
    generation += 1;
    stopWalk();
    void diffHandle?.cancel();
    diffHandle = null;
    pendingSelection = null;
    replacing.value = false;
    repo.value = null;
    refs.value = [];
    refsLoaded.value = false;
    refsError.value = null;
    commits.value = [];
    walk.value = null;
    walkScope.value = { kind: "all" };
    walkFilter.value = undefined;
    streaming.value = false;
    walkError.value = null;
    selectedIndex.value = -1;
    detail.value = null;
    worktrees.value = [];
    worktreesError.value = null;
  }

  /** Ends the current walk: the stream is cancelled and the backend handle closed. */
  function stopWalk(): void {
    walkSerial += 1;
    void walkHandle?.cancel();
    if (walk.value && !walk.value.done) void ipc.closeWalk(walk.value.walkId);
    walkHandle = null;
    walkRecovered = false;
  }

  /** Lists the worktrees of the open repository (the sidebar tab asks for it). */
  async function loadWorktrees(): Promise<void> {
    const root = repo.value?.root;
    if (!root) return;
    const myGeneration = generation;
    const mine = ++worktreesSerial;
    try {
      const list = await ipc.listWorktrees(root);
      // A listing started later holds newer worktrees (a write's answer shown meanwhile).
      if (myGeneration !== generation || mine !== worktreesSerial) return;
      worktrees.value = list;
      worktreesError.value = null;
    } catch (error) {
      if (myGeneration !== generation) return;
      worktreesError.value = toAppError(error);
    }
  }

  /**
   * Shows what git answered about the worktrees (one added, one removed) before they are listed
   * again; the listing that follows replaces it.
   */
  function patchWorktrees(change: (listed: Worktree[]) => Worktree[]): void {
    worktrees.value = change(worktrees.value);
  }

  /** Whether `root` (or the path being opened) is the repository the store shows now. */
  function isCurrentRepository(root: string, path: string): boolean {
    if (repo.value?.root === root) return true;
    const current = state.value;
    return (current.kind === "opening" || current.kind === "error") && current.path === path;
  }

  /** Opens the repository at `path`: description, the first commit pages, then the refs. */
  async function open(path: string): Promise<void> {
    const previous = repo.value?.root;
    reset();
    if (previous) void ipc.closeRepository(previous);
    const myGeneration = generation;
    state.value = { kind: "opening", path };
    const opId = newOpId("open");
    operations.start(opId, "operations.opening");
    let opened: Repo | null = null;
    try {
      opened = await ipc.openRepository(path, opId);
      if (myGeneration !== generation) {
        // Abandoned while opening: the backend cached the engine, so it is closed unless the
        // newer open is for this same repository.
        if (!isCurrentRepository(opened.root, path)) void ipc.closeRepository(opened.root);
        return;
      }
      repo.value = opened;
      state.value = { kind: "ready" };
      // The first page paints before the refs arrive: listing refs with their ahead/behind
      // counts takes longer than the first page on a repository with many branches.
      startWalk(opened.root);
      const listed = await ipc.listRefs(opened.root);
      if (myGeneration !== generation) return;
      refs.value = listed;
      refsLoaded.value = true;
    } catch (error) {
      if (myGeneration !== generation) return;
      const failed = toAppError(error);
      reset();
      state.value = { kind: "error", path, error: failed };
      if (opened) void ipc.closeRepository(opened.root);
    } finally {
      operations.finish(opId);
    }
  }

  /**
   * Starts a walk from the first page. With `skipPages`, the walk repeats the pages an earlier
   * walk already delivered (the backend drops idle walks after a while) and only appends from
   * that page on; the first repeated page must still start with the same commit, otherwise
   * the history changed and the list starts over.
   */
  function startWalk(root: string, skipPages = 0): void {
    const myGeneration = generation;
    const myWalk = walkSerial;
    const opId = newOpId("walk");
    streaming.value = true;
    walkError.value = null;
    operations.start(opId, "operations.loadingHistory");
    const options = walkFilter.value
      ? { ...ipc.defaultWalkOptions, filter: walkFilter.value }
      : ipc.defaultWalkOptions;
    walkHandle = ipc.walkCommits(
      root,
      walkScope.value,
      (page) => receivePage(page, myGeneration, myWalk, skipPages),
      options,
      skipPages + PAGES_PER_REQUEST,
      opId,
    );
    void settleWalk(walkHandle, myGeneration, myWalk, opId);
  }

  /**
   * Lists the history again for `scope` and `filter`. The rows are replaced as the new pages
   * arrive; `selectHash` (the selected commit by default) is selected again when the first
   * request lists it (its change set is kept), otherwise the first row is.
   */
  function restartWalk(scope: WalkScope, filter?: WalkFilter, selectHash?: string): void {
    walkScope.value = scope;
    walkFilter.value = filter;
    const root = repo.value?.root;
    if (!root || state.value.kind !== "ready") return;
    lastRestartAt = Date.now();
    stopWalk();
    pendingSelection = selectHash ?? selectedCommit.value?.hash ?? null;
    replacing.value = false;
    commits.value = [];
    walk.value = null;
    selectedIndex.value = -1;
    startWalk(root);
  }

  /**
   * Lists the current history again after the repository moved (a commit, a checkout, a pull,
   * an operation that went on, a refs change): the rows and the selection stay until the new
   * first page replaces them, where a filter's restart shows skeleton rows. `selectHash` (the
   * selected commit by default) is selected again when the first request lists it, otherwise
   * the first row is; a walk that fails before its first page empties the rows.
   */
  function reloadWalk(selectHash?: string): void {
    const root = repo.value?.root;
    if (!root || state.value.kind !== "ready") return;
    lastRestartAt = Date.now();
    stopWalk();
    pendingSelection = selectHash ?? selectedCommit.value?.hash ?? null;
    replacing.value = commits.value.length > 0;
    walk.value = null;
    startWalk(root);
  }

  /** Asks for the next pages of the current walk. */
  function loadMore(): void {
    if (!canLoadMore.value || !walk.value) return;
    const myGeneration = generation;
    const myWalk = walkSerial;
    const opId = newOpId("walk");
    streaming.value = true;
    operations.start(opId, "operations.loadingHistory");
    walkHandle = ipc.walkContinue(
      walk.value.walkId,
      walk.value.nextIndex,
      (page) => receivePage(page, myGeneration, myWalk),
      PAGES_PER_REQUEST,
      opId,
    );
    void settleWalk(walkHandle, myGeneration, myWalk, opId);
  }

  function receivePage(
    page: WalkPage,
    myGeneration: number,
    myWalk: number,
    skipBefore?: number,
  ): void {
    if (myGeneration !== generation || myWalk !== walkSerial) return;
    if (replacing.value) {
      replacing.value = false;
      commits.value = [];
      selectedIndex.value = -1;
    }
    const skip = skipBefore ?? walk.value?.skipBefore ?? 0;
    if (page.index === 0 && skip > 0 && page.commits[0]?.hash !== commits.value[0]?.hash) {
      // The history changed under the restarted walk: start the list over.
      commits.value = [];
      selectedIndex.value = -1;
      detail.value = null;
      walk.value = { walkId: page.walkId, nextIndex: 1, done: page.done, skipBefore: 0 };
      commits.value = page.commits;
    } else if (page.index >= skip) {
      commits.value = commits.value.concat(page.commits);
      walk.value = {
        walkId: page.walkId,
        nextIndex: page.index + 1,
        done: page.done,
        skipBefore: skip,
      };
    } else {
      walk.value = {
        walkId: page.walkId,
        nextIndex: page.index + 1,
        done: page.done,
        skipBefore: skip,
      };
    }
    if (selectedIndex.value >= 0 || commits.value.length === 0) return;
    if (pendingSelection === null) {
      select(0);
      return;
    }
    const wanted = pendingSelection;
    const inPage = page.commits.findIndex((commit) => commit.hash === wanted);
    if (inPage >= 0) {
      pendingSelection = null;
      selectKeepingDetail(commits.value.length - page.commits.length + inPage);
    }
  }

  /** Ends the wait for a restarted walk's selection: the first row when it was not listed. */
  function settlePendingSelection(): void {
    if (pendingSelection === null) return;
    pendingSelection = null;
    if (selectedIndex.value >= 0) return;
    if (commits.value.length > 0) select(0);
    else detail.value = null;
  }

  async function settleWalk(
    handle: StreamHandle,
    myGeneration: number,
    myWalk: number,
    opId: string,
  ): Promise<void> {
    const current = () => myGeneration === generation && myWalk === walkSerial;
    try {
      await handle.done;
      if (current()) walkRecovered = false;
    } catch (error) {
      if (!current()) return;
      const failed = toAppError(error);
      const root = repo.value?.root;
      const position = walk.value;
      const lost = failed.code === "op.unknown_walk" && root !== undefined && position !== null;
      if (lost && !walkRecovered) {
        // The backend dropped the walk (idle for too long, or a timed-out continuation):
        // start it again and skip the pages already shown.
        walkRecovered = true;
        startWalk(root, position.nextIndex);
        return;
      }
      if (replacing.value) {
        // The rows kept for a reload belong to a history that moved: the banner stands alone.
        replacing.value = false;
        commits.value = [];
        selectedIndex.value = -1;
      }
      walkError.value = failed;
      // No more pages are asked for: the banner says where history stops.
      if (position) walk.value = { ...position, done: true };
    } finally {
      operations.finish(opId);
      if (current()) {
        streaming.value = false;
        settlePendingSelection();
      }
    }
  }

  /** Selects a row whose change set may already be loaded (after a restarted walk). */
  function selectKeepingDetail(index: number): void {
    const commit = commits.value[index];
    if (commit && detail.value?.hash === commit.hash) {
      selectedIndex.value = index;
      return;
    }
    select(index);
  }

  /**
   * Selects a row and loads its change set. A change set that takes longer than
   * `SLOW_DIFF_MS` (a commit of a thousand files) names itself in the status bar until its
   * last page; a quick one, the usual case while j and k walk the history, shows nothing.
   */
  function select(index: number): void {
    if (index < 0 || index >= commits.value.length) return;
    selectedIndex.value = index;
    const commit = commits.value[index];
    const root = repo.value?.root;
    if (!commit || !root) return;
    void diffHandle?.cancel();
    const myGeneration = generation;
    // Each request has its own number: a stream of the same commit started earlier (a double
    // click, k on the first row) is ignored, pages and cancellation alike.
    diffRequest += 1;
    const request = diffRequest;
    const current = () => myGeneration === generation && request === diffRequest;
    const hash = commit.hash;
    detail.value = { hash, files: [], additions: 0, deletions: 0, totalFiles: 0, loading: true };
    const handle = ipc.diff(root, { kind: "commit", hash }, (page: DiffPage) => {
      if (!current() || !detail.value) return;
      detail.value = {
        ...detail.value,
        files: detail.value.files.concat(page.files),
        additions: page.additions,
        deletions: page.deletions,
        totalFiles: page.totalFiles,
      };
    });
    diffHandle = handle;
    const opId = newOpId("commit-diff");
    const slow = setTimeout(() => {
      if (current()) operations.start(opId, "operations.loadingDiff");
    }, SLOW_DIFF_MS);
    void handle.done
      .then(() => {
        if (current() && detail.value) detail.value = { ...detail.value, loading: false };
      })
      .catch((error: unknown) => {
        if (current() && detail.value) {
          detail.value = { ...detail.value, loading: false, error: toAppError(error) };
        }
      })
      .finally(() => {
        clearTimeout(slow);
        operations.finish(opId);
      });
  }

  /** Lists the refs again (after a `repo:changed` with refs, or a branch switch outside). */
  /**
   * Lists the refs again; `tipsMoved` says whether HEAD, a branch or a tag points somewhere
   * else than before (a stash entry or a reflog touch does not count), so the watcher knows
   * when the history must be listed again.
   */
  async function refreshRefs(options: { arm?: MotionList } = {}): Promise<{ tipsMoved: boolean }> {
    const root = repo.value?.root;
    if (!root) return { tipsMoved: false };
    const myGeneration = generation;
    const mine = ++refsSerial;
    if (options.arm) armNext = options.arm;
    const before = tipsSignature(refs.value);
    try {
      const listed = await ipc.listRefs(root);
      if (myGeneration !== generation) return { tipsMoved: false };
      // A listing started later holds newer refs (a write's answer shown meanwhile, then read):
      // this one still says whether the tips moved, for the history to follow.
      if (mine !== refsSerial) return { tipsMoved: tipsSignature(listed) !== before };
      // The watcher's listing may be the one that lands last: it carries the motion asked.
      if (armNext !== null) arm(armNext);
      armNext = null;
      refs.value = listed;
      refsLoaded.value = true;
      refsError.value = null;
      followHead(listed);
      return { tipsMoved: tipsSignature(listed) !== before };
    } catch (error) {
      // The refs shown stay until the next change; the picker reports the failure.
      if (myGeneration === generation) refsError.value = toAppError(error);
      if (mine === refsSerial) armNext = null;
      return { tipsMoved: false };
    }
  }

  /**
   * Shows what git answered before the refs are listed again: a branch or a tag deleted, a branch
   * renamed, a stash dropped or popped (the later ones take the number before theirs). The
   * caller lists the refs again right after, and that listing replaces what this shows.
   */
  function patchRefs(patch: RefPatch): void {
    if (patch.kind === "delete") {
      refs.value = refs.value.filter((entry) => entry.fullName !== patch.fullName);
    } else if (patch.kind === "rename") {
      refs.value = refs.value.map((entry) =>
        entry.fullName === patch.fullName
          ? { ...entry, name: patch.name, fullName: patch.newFullName }
          : entry,
      );
    } else {
      const gone = refs.value.find(
        (entry) => entry.kind === "stash" && entry.target === patch.hash,
      );
      const dropped = gone ? stashNumber(gone.name) : null;
      if (!gone || dropped === null) return;
      refs.value = refs.value.flatMap((entry) => {
        if (entry === gone) return [];
        const number = entry.kind === "stash" ? stashNumber(entry.name) : null;
        if (number === null || number < dropped) return [entry];
        const name = `stash@{${number - 1}}`;
        return [{ ...entry, name, fullName: entry.fullName.replace(entry.name, name) }];
      });
    }
  }

  /** A switch (here or in a terminal) names the new branch wherever the open's did. */
  function followHead(listed: GitRef[]): void {
    const head = headState(listed);
    const current = repo.value;
    if (!head || !current) return;
    if (current.currentBranch === head.currentBranch && current.detached === head.detached) return;
    repo.value = { ...current, ...head };
  }

  /** Whether the walk was listed again within `withinMs` (the app's own writes do it). */
  function recentlyRestarted(withinMs = 2000): boolean {
    return Date.now() - lastRestartAt < withinMs;
  }

  /** Closes the repository: its project's empty state, or Home, shows. */
  async function close(): Promise<void> {
    const root = repo.value?.root;
    reset();
    state.value = { kind: "empty" };
    if (root) await ipc.closeRepository(root);
  }

  /** Retries opening after an error. */
  function retry(): Promise<void> {
    const current = state.value;
    if (current.kind === "error" || current.kind === "opening") return open(current.path);
    return Promise.resolve();
  }

  return {
    state,
    repo,
    refs,
    refsLoaded,
    refsError,
    commits,
    walk,
    walkScope,
    walkFilter,
    streaming,
    walkError,
    selectedIndex,
    selectedCommit,
    detail,
    worktrees,
    worktreesError,
    canLoadMore,
    currentBranch,
    open,
    loadMore,
    restartWalk,
    reloadWalk,
    /** The history is listed again with the rows kept (`reloadWalk`). */
    reloading: replacing,
    recentlyRestarted,
    loadWorktrees,
    refreshRefs,
    patchRefs,
    patchWorktrees,
    select,
    close,
    retry,
  };
});
