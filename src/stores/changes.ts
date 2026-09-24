// The changes screen: the working
// tree as two lists, Unstaged (the working tree against the index, untracked files as added)
// and Staged (the index against HEAD), the selected file, the commit draft and its context,
// and every write of the screen through the staging commands. Each list reads again what
// changed, one reload at a time (`reloads.ts`): the paths a write or the watcher names, whole
// when those cannot say enough, and the staged list whole when HEAD moves; the selection
// survives by path. The draft is kept here so that leaving the screen does not lose a
// half-written message.

import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";

import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type {
  ChangeSet,
  CommitContext,
  DiffPage,
  DiffTarget,
  FileChange,
  PatchSelection,
  RepoChanged,
  SelectionTarget,
} from "@/ipc/schemas";
import type { StreamHandle } from "@/ipc/stream";

import { useOperationsStore } from "./operations";
import {
  MAX_RESTRICTED_PATHS,
  mergeRestricted,
  pairingPaths,
  type Reload,
  Reloader,
  reloadFor,
  requestedPaths,
  unspellable,
} from "./reloads";
import { headTarget, useRepoStore } from "./repo";

export type ChangeList = "unstaged" | "staged";

export interface ChangeSetState {
  files: FileChange[];
  additions: number;
  deletions: number;
  loading: boolean;
  error?: AppError;
}

export interface CommitDraft {
  subject: string;
  body: string;
  amend: boolean;
  signoff: boolean;
}

export type WriteKind = "stage" | "unstage" | "discard" | "commit";

/** What the last failed write was doing, for the status bar and the banner. */
export interface FailedWrite {
  kind: WriteKind;
  /** Files the write named; 0 for a commit. */
  files: number;
  /** The one file of a selection or a single-file write, for the stale-hunk sentence. */
  path: string | null;
}

/** The status bar label of each write. */
const writeLabels: Record<WriteKind, string> = {
  stage: "operations.staging",
  unstage: "operations.unstaging",
  discard: "operations.discarding",
  commit: "operations.committing",
};

/** A list read again at `paths`, whole past what a restricted reload takes. */
const atPaths = (paths: string[]): Reload =>
  paths.length > MAX_RESTRICTED_PATHS ? { kind: "full" } : { kind: "paths", paths };

const nothing: Reload = { kind: "none" };

/** The paths a write to `files` moves: each path, and the old side of a rename. */
const pathsOf = (files: FileChange[]): string[] =>
  files.flatMap((file) => (file.oldPath === null ? [file.path] : [file.path, file.oldPath]));

/** The key of a changed line inside a file's hunks, for the selection. */
export function lineKey(hunkIndex: number, lineIndex: number): string {
  return `${hunkIndex}:${lineIndex}`;
}

/** The engine's diff target of a list. */
export function diffTargetOfList(list: ChangeList): DiffTarget {
  return list === "unstaged" ? { kind: "working-tree", base: "index" } : { kind: "index" };
}

/** What a selection of lines of a list's file does with the selection target given. */
export function selectionOf(file: FileChange, selected: Set<string>): PatchSelection {
  return {
    path: file.path,
    status: file.status,
    lossy: file.isLossy,
    hunks: file.hunks.map((hunk, h) => ({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: hunk.lines.map((line, l) => ({
        kind: line.kind,
        text: line.text,
        noNewline: line.noNewline,
        selected: line.kind !== "context" && selected.has(lineKey(h, l)),
      })),
    })),
  };
}

/** A whole-file selection: every changed line. */
export function wholeSelection(file: FileChange): PatchSelection {
  const all = new Set<string>();
  file.hunks.forEach((hunk, h) =>
    hunk.lines.forEach((line, l) => {
      if (line.kind !== "context") all.add(lineKey(h, l));
    }),
  );
  return selectionOf(file, all);
}

/** The commit message git receives: the subject, a blank line, the body. */
export function messageOf(draft: Pick<CommitDraft, "subject" | "body">): string {
  const subject = draft.subject.trim();
  const body = draft.body.trim();
  return body === "" ? subject : `${subject}\n\n${body}`;
}

/** A template minus its comment lines: what the box prefills (the comments are guidance). */
export function templateBody(template: string): string {
  return template
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .trim();
}

const emptyList = (): ChangeSetState => ({
  files: [],
  additions: 0,
  deletions: 0,
  loading: false,
});

export const useChangesStore = defineStore("changes", () => {
  const repo = useRepoStore();
  const operations = useOperationsStore();

  const unstaged = shallowRef<ChangeSetState>(emptyList());
  const staged = shallowRef<ChangeSetState>(emptyList());
  const selected = ref<{ list: ChangeList; path: string } | null>(null);
  /** The write in flight, as the status bar names it; null between writes. */
  const busy = ref<string | null>(null);
  /** The last failed write, for the banner; cleared by the next write or a dismissal. */
  const actionError = ref<AppError | null>(null);
  const failed = ref<FailedWrite | null>(null);
  const context = ref<CommitContext | null>(null);
  const draft = ref<CommitDraft>({ subject: "", body: "", amend: false, signoff: false });
  /** The hash of the last commit made here, for the graph to select. */
  const lastCommit = ref<string | null>(null);
  /** Whether the lists were ever loaded for the open repository. */
  const loaded = ref(false);

  const handles: Record<ChangeList, StreamHandle | null> = {
    unstaged: null,
    staged: null,
  };
  /** Bumped when a list's stream stops, so a superseded stream's pages and ending are dropped. */
  const serials: Record<ChangeList, number> = { unstaged: 0, staged: 0 };
  /** The operation of a list's restricted read in flight, cancelled when a whole one starts. */
  const restricted: Record<ChangeList, string | null> = { unstaged: null, staged: null };
  /** One reload at a time per list: whole, or at the paths that changed. */
  const reloaders: Record<ChangeList, Reloader> = {
    unstaged: new Reloader({
      full: () => reloadWhole("unstaged"),
      paths: (paths) => readAt("unstaged", paths),
    }),
    staged: new Reloader({
      full: () => reloadWhole("staged"),
      paths: (paths) => readAt("staged", paths),
    }),
  };
  let loadedRoot: string | null = null;
  /** Where the selection was when a write started, so its place is kept once the file left. */
  let anchor: { list: ChangeList; index: number } | null = null;

  const listOf = (list: ChangeList) => (list === "unstaged" ? unstaged : staged);
  const unstagedCount = computed(() => unstaged.value.files.length);
  const stagedCount = computed(() => staged.value.files.length);
  const loading = computed(() => unstaged.value.loading || staged.value.loading);
  const error = computed(() => unstaged.value.error ?? staged.value.error ?? null);
  const isEmpty = computed(
    () =>
      loaded.value &&
      !loading.value &&
      !error.value &&
      unstagedCount.value + stagedCount.value === 0,
  );
  const selectedFile = computed<FileChange | null>(() => {
    const current = selected.value;
    if (!current) return null;
    return listOf(current.list).value.files.find((file) => file.path === current.path) ?? null;
  });
  const canCommit = computed(
    () =>
      busy.value === null &&
      draft.value.subject.trim() !== "" &&
      (stagedCount.value > 0 || draft.value.amend) &&
      !(draft.value.amend && (context.value?.unborn ?? false)),
  );

  function stop(list: ChangeList): void {
    serials[list] += 1;
    void handles[list]?.cancel();
    handles[list] = null;
    const reading = restricted[list];
    if (reading !== null) {
      restricted[list] = null;
      void ipc.cancelOperation(reading).catch(() => undefined);
    }
  }

  function stream(list: ChangeList, root: string): Promise<void> {
    stop(list);
    const mine = serials[list];
    const current = () => mine === serials[list];
    const target = listOf(list);
    target.value = { ...target.value, loading: true, error: undefined };
    const opId = newOpId(`changes-${list}`);
    operations.start(opId, "operations.readingChanges");
    // Whitespace is never ignored here: a patch built from a diff that hid whitespace changes
    // would not apply.
    const handle = ipc.diff(
      root,
      diffTargetOfList(list),
      (page: DiffPage, seq: number) => {
        if (!current()) return;
        const previous = seq === 0 ? [] : target.value.files;
        target.value = {
          ...target.value,
          files: previous.concat(page.files),
          additions: page.additions,
          deletions: page.deletions,
        };
      },
      { ...ipc.defaultDiffOptions, ignoreWhitespace: false },
      opId,
    );
    handles[list] = handle;
    return handle.done
      .then(() => {
        if (current()) target.value = { ...target.value, loading: false };
      })
      .catch((failure: unknown) => {
        if (current()) {
          target.value = { ...target.value, loading: false, error: toAppError(failure) };
        }
      })
      .finally(() => {
        operations.finish(opId);
        if (current()) settleSelection();
      });
  }

  /** Streams `list` again whole, for the repository the lists were loaded for. */
  function reloadWhole(list: ChangeList): Promise<void> {
    const root = repo.repo?.root;
    return root !== undefined && root === loadedRoot ? stream(list, root) : Promise.resolve();
  }

  /**
   * Reads `list` again at the paths that changed and merges the result into it; false when the
   * list must be read whole instead (too many paths or files, a failed read, a list in error).
   */
  async function readAt(list: ChangeList, changed: string[]): Promise<boolean> {
    const root = repo.repo?.root;
    if (root === undefined || root !== loadedRoot) return true;
    const target = listOf(list);
    if (target.value.error) return false;
    const mine = serials[list];
    // A whole reload that started meanwhile, or another repository, holds the newer list.
    const superseded = () => mine !== serials[list] || root !== repo.repo?.root;
    let requested = requestedPaths(target.value.files, changed);
    let result = await readPaths(list, root, requested);
    if (superseded()) return true;
    if (result === null) return false;
    // The staged list pairs renames: a read that touched an addition, a deletion or a rename
    // reads again with the listed files it may pair with.
    if (list === "staged") {
      const extra = pairingPaths(target.value.files, requested, result.files);
      if (extra.length > 0) {
        requested = [...new Set([...requested, ...extra])];
        result = await readPaths(list, root, requested);
        if (superseded()) return true;
        if (result === null) return false;
      }
    }
    const files = mergeRestricted(target.value.files, requested, result.files);
    target.value = {
      ...target.value,
      files,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    };
    // A write moves the selection itself once both of its lists landed.
    if (anchor === null) settleSelection();
    return true;
  }

  /** The restricted diff of `list` at `paths`; null when the list must be read whole. */
  async function readPaths(
    list: ChangeList,
    root: string,
    paths: string[],
  ): Promise<ChangeSet | null> {
    if (paths.length > MAX_RESTRICTED_PATHS || paths.some(unspellable)) return null;
    const opId = newOpId(`changes-${list}`);
    restricted[list] = opId;
    try {
      // Whitespace is never ignored here, as in the whole list.
      return await ipc.diffPaths(
        root,
        diffTargetOfList(list),
        paths,
        { ...ipc.defaultDiffOptions, ignoreWhitespace: false },
        opId,
      );
    } catch {
      return null;
    } finally {
      if (restricted[list] === opId) restricted[list] = null;
    }
  }

  /**
   * Keeps the selection on its file when it is still listed; a file that left after a write
   * hands the selection to the row that took its place (so staging top-down keeps going),
   * else the first file shown.
   */
  function settleSelection(): void {
    if (loading.value) return;
    const current = selected.value;
    const place = anchor;
    anchor = null;
    if (current && listOf(current.list).value.files.some((file) => file.path === current.path)) {
      return;
    }
    if (place) {
      const files = listOf(place.list).value.files;
      const next = files[Math.min(place.index, files.length - 1)];
      if (next) {
        selected.value = { list: place.list, path: next.path };
        return;
      }
    }
    const first = unstaged.value.files[0]
      ? { list: "unstaged" as const, path: unstaged.value.files[0].path }
      : staged.value.files[0]
        ? { list: "staged" as const, path: staged.value.files[0].path }
        : null;
    selected.value = first;
  }

  /** Streams both lists again. */
  function load(): void {
    const root = repo.repo?.root;
    if (!root) {
      stop("unstaged");
      stop("staged");
      reloaders.unstaged.clear();
      reloaders.staged.clear();
      unstaged.value = emptyList();
      staged.value = emptyList();
      selected.value = null;
      loaded.value = false;
      loadedRoot = null;
      return;
    }
    if (loadedRoot !== root) {
      reloaders.unstaged.clear();
      reloaders.staged.clear();
      selected.value = null;
      draft.value = { subject: "", body: "", amend: false, signoff: false };
      context.value = null;
      loadedRoot = root;
    }
    loaded.value = true;
    reloaders.unstaged.request({ kind: "full" });
    reloaders.staged.request({ kind: "full" });
  }

  function select(list: ChangeList, path: string): void {
    selected.value = { list, path };
  }

  /**
   * Runs a write with its status bar label, then reads again what it moved (`reload`); a
   * failure lands in the banner. The watcher's changes wait for the write meanwhile.
   */
  async function write(
    kind: WriteKind,
    files: number,
    path: string | null,
    reload: Record<ChangeList, Reload>,
    run: (root: string) => Promise<unknown>,
  ): Promise<boolean> {
    const root = repo.repo?.root;
    if (!root || busy.value !== null) return false;
    const label = writeLabels[kind];
    busy.value = label;
    reloaders.unstaged.hold();
    reloaders.staged.hold();
    actionError.value = null;
    failed.value = null;
    const current = selected.value;
    anchor = current
      ? {
          list: current.list,
          index: Math.max(
            0,
            listOf(current.list).value.files.findIndex((file) => file.path === current.path),
          ),
        }
      : null;
    const opId = newOpId("changes-write");
    operations.start(opId, label);
    let done = false;
    try {
      await run(root);
      done = true;
    } catch (failure) {
      actionError.value = toAppError(failure);
      failed.value = { kind, files, path };
    } finally {
      operations.finish(opId);
      busy.value = null;
      reloaders.unstaged.request(reload.unstaged);
      reloaders.staged.request(reload.staged);
      reloaders.unstaged.resume();
      reloaders.staged.resume();
    }
    // The selection moves once both lists show the write, whichever answered first: a file
    // that left hands it to the row that took its place.
    await Promise.all([reloaders.unstaged.settled(), reloaders.staged.settled()]);
    settleSelection();
    return done;
  }

  function stage(paths: string[]): Promise<boolean> {
    if (paths.length === 0) return Promise.resolve(false);
    const both = atPaths(paths);
    return write(
      "stage",
      paths.length,
      paths.length === 1 ? (paths[0] ?? null) : null,
      { unstaged: both, staged: both },
      (root) => ipc.stagePaths(root, paths),
    );
  }

  function unstage(paths: string[]): Promise<boolean> {
    if (paths.length === 0) return Promise.resolve(false);
    const both = atPaths(paths);
    return write(
      "unstage",
      paths.length,
      paths.length === 1 ? (paths[0] ?? null) : null,
      { unstaged: both, staged: both },
      (root) => ipc.unstagePaths(root, paths),
    );
  }

  /** Discards unstaged files: added ones are untracked and go, the rest return to the index. */
  function discard(files: FileChange[]): Promise<boolean> {
    const untracked = files.filter((file) => file.status === "added").map((file) => file.path);
    const tracked = files.filter((file) => file.status !== "added").map((file) => file.path);
    if (untracked.length + tracked.length === 0) return Promise.resolve(false);
    return write(
      "discard",
      files.length,
      files.length === 1 ? (files[0]?.path ?? null) : null,
      { unstaged: atPaths(pathsOf(files)), staged: nothing },
      (root) => ipc.discardPaths(root, tracked, untracked),
    );
  }

  /** Applies the selected lines of `file` (every changed line when `selectedKeys` is null). */
  function applySelection(
    target: SelectionTarget,
    file: FileChange,
    selectedKeys: Set<string> | null,
  ): Promise<boolean> {
    const selection = selectedKeys ? selectionOf(file, selectedKeys) : wholeSelection(file);
    const moved = atPaths(pathsOf([file]));
    const reload = { unstaged: moved, staged: target === "discard" ? nothing : moved };
    return write(target, 1, file.path, reload, (root) =>
      ipc.applySelection(root, target, selection),
    );
  }

  function stageAll(): Promise<boolean> {
    return stage(unstaged.value.files.map((file) => file.path));
  }

  function unstageAll(): Promise<boolean> {
    return unstage(staged.value.files.map((file) => file.path));
  }

  function discardAll(): Promise<boolean> {
    return discard(unstaged.value.files);
  }

  /** The author, the template and HEAD's message; prefills an empty draft with the template. */
  async function loadContext(): Promise<void> {
    const root = repo.repo?.root;
    if (!root) return;
    try {
      const loaded = await ipc.commitContext(root);
      context.value = loaded;
      if (draft.value.subject === "" && draft.value.body === "" && !draft.value.amend) {
        const prefilled = loaded.preparedMessage ?? templateBody(loaded.template ?? "");
        if (prefilled !== "") setMessage(prefilled);
      }
    } catch (failure) {
      actionError.value = toAppError(failure);
    }
  }

  /** Splits a whole message into the draft's subject and body. */
  function setMessage(message: string): void {
    const [subject = "", ...rest] = message.split("\n");
    draft.value = { ...draft.value, subject, body: rest.join("\n").trim() };
  }

  function setDraft(patch: Partial<CommitDraft>): void {
    const next = { ...draft.value, ...patch };
    // Ticking amend prefills HEAD's message into an empty draft; unticking clears it again.
    if (patch.amend === true && !draft.value.amend && context.value?.headMessage) {
      if (next.subject.trim() === "" && next.body.trim() === "") {
        draft.value = next;
        setMessage(context.value.headMessage);
        return;
      }
    } else if (patch.amend === false && draft.value.amend && context.value?.headMessage) {
      if (messageOf(next) === context.value.headMessage.trim()) {
        next.subject = "";
        next.body = "";
      }
    }
    draft.value = next;
  }

  /**
   * Commits the index with the draft; on success the box clears, the context reloads and the
   * graph lists the history again with the new commit selected.
   */
  async function commit(): Promise<boolean> {
    if (!canCommit.value) return false;
    const request = {
      message: messageOf(draft.value),
      amend: draft.value.amend,
      signoff: draft.value.signoff,
    };
    // A commit moves HEAD, not the index: the staged list is read whole again.
    const reload: Record<ChangeList, Reload> = { unstaged: nothing, staged: { kind: "full" } };
    const done = await write("commit", 0, null, reload, async (root) => {
      const result = await ipc.commit(root, request);
      lastCommit.value = result.hash;
    });
    if (done) {
      draft.value = { subject: "", body: "", amend: false, signoff: draft.value.signoff };
      void loadContext();
      if (lastCommit.value) repo.restartWalk(repo.walkScope, repo.walkFilter, lastCommit.value);
    }
    return done;
  }

  function dismissError(): void {
    actionError.value = null;
    failed.value = null;
  }

  /**
   * The watcher: each list reads again what the change moved (the working tree's paths for the
   * unstaged list, the index entries for both, whole when those cannot say enough), and a refs
   * change the context. During a write the reloads wait for it.
   */
  function onRepoChanged(change: RepoChanged): void {
    if (!loaded.value) return;
    reloaders.unstaged.request(reloadFor(change, true));
    reloaders.staged.request(reloadFor(change, false));
    if (change.kinds.includes("refs")) void loadContext();
  }

  // The staged list is HEAD against the index, so HEAD moving without the index (a soft reset
  // in a terminal) streams it again once the refs listing shows the move. A branch moving
  // elsewhere (a commit in a linked worktree) leaves HEAD, and both lists, alone.
  watch(
    () => (repo.refsLoaded ? headTarget(repo.refs) : undefined),
    (now, before) => {
      const root = repo.repo?.root;
      if (now === undefined || before === undefined || !root || root !== loadedRoot) return;
      if (loaded.value) reloaders.staged.request({ kind: "full" });
    },
  );

  return {
    unstaged,
    staged,
    selected,
    selectedFile,
    busy,
    actionError,
    failed,
    context,
    draft,
    lastCommit,
    loaded,
    unstagedCount,
    stagedCount,
    loading,
    error,
    isEmpty,
    canCommit,
    load,
    select,
    stage,
    unstage,
    discard,
    applySelection,
    stageAll,
    unstageAll,
    discardAll,
    loadContext,
    setDraft,
    setMessage,
    commit,
    dismissError,
    onRepoChanged,
  };
});
