// The open repository: its description, refs, the commit pages streamed from the walk, the
// selected commit and its change set. Everything comes from the IPC client; the store keeps
// only the pages it has received and asks for more on demand.

import { defineStore } from "pinia";
import { computed, ref } from "vue";

import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type {
  CommitNode,
  DiffPage,
  FileChange,
  Ref as GitRef,
  Repo,
  WalkPage,
  Worktree,
} from "@/ipc/schemas";
import type { StreamHandle } from "@/ipc/stream";

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

export const useRepoStore = defineStore("repo", () => {
  const operations = useOperationsStore();

  const state = ref<RepoState>({ kind: "empty" });
  const repo = ref<Repo | null>(null);
  const refs = ref<GitRef[]>([]);
  const commits = ref<CommitNode[]>([]);
  const walk = ref<WalkPosition | null>(null);
  const streaming = ref(false);
  const walkError = ref<AppError | null>(null);
  const selectedIndex = ref(-1);
  const detail = ref<Detail | null>(null);
  const worktrees = ref<Worktree[]>([]);
  const worktreesError = ref<AppError | null>(null);

  let walkHandle: StreamHandle | null = null;
  let diffHandle: StreamHandle | null = null;
  let generation = 0;

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
    void walkHandle?.cancel();
    void diffHandle?.cancel();
    if (walk.value && !walk.value.done) void ipc.closeWalk(walk.value.walkId);
    walkHandle = null;
    diffHandle = null;
    repo.value = null;
    refs.value = [];
    commits.value = [];
    walk.value = null;
    streaming.value = false;
    walkError.value = null;
    selectedIndex.value = -1;
    detail.value = null;
    worktrees.value = [];
    worktreesError.value = null;
  }

  /** Lists the worktrees of the open repository (the sidebar tab asks for it). */
  async function loadWorktrees(): Promise<void> {
    const root = repo.value?.root;
    if (!root) return;
    const myGeneration = generation;
    try {
      const list = await ipc.listWorktrees(root);
      if (myGeneration !== generation) return;
      worktrees.value = list;
      worktreesError.value = null;
    } catch (error) {
      if (myGeneration !== generation) return;
      worktreesError.value = toAppError(error);
    }
  }

  /** Opens the repository at `path`: description, refs, then the first commit pages. */
  async function open(path: string): Promise<void> {
    const previous = repo.value?.root;
    reset();
    if (previous) void ipc.closeRepository(previous);
    const myGeneration = generation;
    state.value = { kind: "opening", path };
    const opId = newOpId("open");
    operations.start(opId, "operations.opening");
    try {
      const opened = await ipc.openRepository(path, opId);
      if (myGeneration !== generation) return;
      repo.value = opened;
      state.value = { kind: "ready" };
      // The first page paints before the refs arrive: listing refs with their ahead/behind
      // counts takes longer than the first page on a repository with many branches.
      startWalk(opened.root);
      const listed = await ipc.listRefs(opened.root);
      if (myGeneration !== generation) return;
      refs.value = listed;
    } catch (error) {
      if (myGeneration !== generation) return;
      const failed = toAppError(error);
      reset();
      state.value = { kind: "error", path, error: failed };
    } finally {
      operations.finish(opId);
    }
  }

  function startWalk(root: string): void {
    const myGeneration = generation;
    const opId = newOpId("walk");
    streaming.value = true;
    walkError.value = null;
    operations.start(opId, "operations.loadingHistory");
    walkHandle = ipc.walkCommits(
      root,
      { kind: "all" },
      (page) => receivePage(page, myGeneration),
      ipc.defaultWalkOptions,
      PAGES_PER_REQUEST,
      opId,
    );
    void settleWalk(walkHandle, myGeneration, opId);
  }

  /** Asks for the next pages of the current walk. */
  function loadMore(): void {
    if (!canLoadMore.value || !walk.value) return;
    const myGeneration = generation;
    const opId = newOpId("walk");
    streaming.value = true;
    operations.start(opId, "operations.loadingHistory");
    walkHandle = ipc.walkContinue(
      walk.value.walkId,
      walk.value.nextIndex,
      (page) => receivePage(page, myGeneration),
      PAGES_PER_REQUEST,
      opId,
    );
    void settleWalk(walkHandle, myGeneration, opId);
  }

  function receivePage(page: WalkPage, myGeneration: number): void {
    if (myGeneration !== generation) return;
    commits.value = commits.value.concat(page.commits);
    walk.value = { walkId: page.walkId, nextIndex: page.index + 1, done: page.done };
    if (selectedIndex.value < 0 && commits.value.length > 0) select(0);
  }

  async function settleWalk(
    handle: StreamHandle,
    myGeneration: number,
    opId: string,
  ): Promise<void> {
    try {
      await handle.done;
    } catch (error) {
      if (myGeneration === generation) walkError.value = toAppError(error);
    } finally {
      operations.finish(opId);
      if (myGeneration === generation) streaming.value = false;
    }
  }

  /** Selects a row and loads its change set. */
  function select(index: number): void {
    if (index < 0 || index >= commits.value.length) return;
    selectedIndex.value = index;
    const commit = commits.value[index];
    const root = repo.value?.root;
    if (!commit || !root) return;
    void diffHandle?.cancel();
    const myGeneration = generation;
    const hash = commit.hash;
    detail.value = { hash, files: [], additions: 0, deletions: 0, totalFiles: 0, loading: true };
    const handle = ipc.diff(root, { kind: "commit", hash }, (page: DiffPage) => {
      if (myGeneration !== generation || detail.value?.hash !== hash) return;
      detail.value = {
        ...detail.value,
        files: detail.value.files.concat(page.files),
        additions: page.additions,
        deletions: page.deletions,
        totalFiles: page.totalFiles,
      };
    });
    diffHandle = handle;
    void handle.done
      .then(() => {
        if (myGeneration === generation && detail.value?.hash === hash) {
          detail.value = { ...detail.value, loading: false };
        }
      })
      .catch((error: unknown) => {
        if (myGeneration === generation && detail.value?.hash === hash) {
          detail.value = { ...detail.value, loading: false, error: toAppError(error) };
        }
      });
  }

  /** Closes the repository and returns to the empty shell. */
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
    commits,
    walk,
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
    loadWorktrees,
    select,
    close,
    retry,
  };
});
