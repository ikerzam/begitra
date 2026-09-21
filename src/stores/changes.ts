// The changes screen: the working
// tree as two lists, Unstaged (the working tree against the index, untracked files as added)
// and Staged (the index against HEAD), the selected file, the commit draft and its context,
// and every write of the screen through the staging commands. Both lists reload after each
// write and when the watcher reports a status or index change; the selection survives by
// path. The draft is kept here so that leaving the screen does not lose a half-written
// message.

import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";

import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type {
  CommitContext,
  DiffPage,
  DiffTarget,
  FileChange,
  PatchSelection,
  SelectionTarget,
} from "@/ipc/schemas";
import type { StreamHandle } from "@/ipc/stream";

import { useOperationsStore } from "./operations";
import { useRepoStore } from "./repo";

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
  let serial = 0;
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
    void handles[list]?.cancel();
    handles[list] = null;
  }

  function stream(list: ChangeList, root: string, mine: number): void {
    stop(list);
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
        if (mine !== serial) return;
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
    void handle.done
      .then(() => {
        if (mine === serial) target.value = { ...target.value, loading: false };
      })
      .catch((failure: unknown) => {
        if (mine === serial) {
          target.value = { ...target.value, loading: false, error: toAppError(failure) };
        }
      })
      .finally(() => {
        operations.finish(opId);
        if (mine === serial) settleSelection();
      });
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
    serial += 1;
    if (!root) {
      stop("unstaged");
      stop("staged");
      unstaged.value = emptyList();
      staged.value = emptyList();
      selected.value = null;
      loaded.value = false;
      loadedRoot = null;
      return;
    }
    if (loadedRoot !== root) {
      selected.value = null;
      draft.value = { subject: "", body: "", amend: false, signoff: false };
      context.value = null;
      loadedRoot = root;
    }
    loaded.value = true;
    stream("unstaged", root, serial);
    stream("staged", root, serial);
  }

  function select(list: ChangeList, path: string): void {
    selected.value = { list, path };
  }

  /** Runs a write with its status bar label, then reloads; a failure lands in the banner. */
  async function write(
    kind: WriteKind,
    files: number,
    path: string | null,
    run: (root: string) => Promise<unknown>,
  ): Promise<boolean> {
    const root = repo.repo?.root;
    if (!root || busy.value !== null) return false;
    const label = writeLabels[kind];
    busy.value = label;
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
    try {
      await run(root);
      return true;
    } catch (failure) {
      actionError.value = toAppError(failure);
      failed.value = { kind, files, path };
      return false;
    } finally {
      operations.finish(opId);
      busy.value = null;
      load();
    }
  }

  function stage(paths: string[]): Promise<boolean> {
    if (paths.length === 0) return Promise.resolve(false);
    return write("stage", paths.length, paths.length === 1 ? (paths[0] ?? null) : null, (root) =>
      ipc.stagePaths(root, paths),
    );
  }

  function unstage(paths: string[]): Promise<boolean> {
    if (paths.length === 0) return Promise.resolve(false);
    return write("unstage", paths.length, paths.length === 1 ? (paths[0] ?? null) : null, (root) =>
      ipc.unstagePaths(root, paths),
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
    return write(target, 1, file.path, (root) => ipc.applySelection(root, target, selection));
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
    const done = await write("commit", 0, null, async (root) => {
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

  /** The watcher's kinds: a status or index change reloads the lists and the context. */
  function onRepoChanged(kinds: string[]): void {
    if (!loaded.value || busy.value !== null) return;
    if (kinds.includes("status") || kinds.includes("index")) load();
    if (kinds.includes("refs")) void loadContext();
  }

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
