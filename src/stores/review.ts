// Review focus state: the target under review (the selected commit by default, or what the
// picker, the palette and the graph's pins chose), its change set, the file filters and the
// open file, the viewer options, and the review state persisted per repository and target
// through the annotations commands: files and hunks marked reviewed, each mark holding the
// content it was given for, one note per file, and a note's resolution (an agent's reply,
// written through the agent server). The shell reads them again when the window comes back
// (`refreshAnnotations`), so what an agent wrote meanwhile shows.

import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";

import { isLockfile } from "@/components/lockfiles";
import type { FileFilters } from "@/detail/groupFiles";
import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type {
  DiffLine,
  DiffPage,
  DiffTarget,
  FileChange,
  Hunk,
  Ref,
  RepoChanged,
} from "@/ipc/schemas";
import type { StreamHandle } from "@/ipc/stream";
import { fileSides } from "@/review/sides";
import { baseName, shortHash } from "@/shell/format";

import { useOperationsStore } from "./operations";
import {
  MAX_RESTRICTED_PATHS,
  mergeRestricted,
  pairingPaths,
  Reloader,
  reloadFor,
  requestedPaths,
  unspellable,
} from "./reloads";
import { useRepoStore } from "./repo";
import { useSettingsStore, type DiffLayout } from "./settings";
import { useToastsStore } from "./toasts";

export type ReviewTarget =
  | { kind: "commit"; hash: string }
  | { kind: "range"; from: string; to: string; threeDot: boolean }
  /** The working tree against the index, untracked files included. */
  | { kind: "worktree" }
  /** The index against HEAD. */
  | { kind: "index" }
  | { kind: "revisionToWorktree"; revision: string };

export interface ReviewChangeSet {
  files: FileChange[];
  additions: number;
  deletions: number;
  totalFiles: number;
  loading: boolean;
  error?: AppError;
}

/** A note's resolution: the reply and when it was written, Unix seconds. */
export interface NoteResolution {
  reply: string;
  at: number;
}

/** The stable key a target's marks and notes are stored under. */
export function targetKey(target: ReviewTarget): string {
  switch (target.kind) {
    case "commit":
      return target.hash;
    case "range":
      return `${target.from}${target.threeDot ? "..." : ".."}${target.to}`;
    case "worktree":
      return "worktree";
    case "index":
      return "index";
    case "revisionToWorktree":
      return `${target.revision}..worktree`;
  }
}

/** The engine's diff target of a review target. */
export function diffTargetOf(target: ReviewTarget): DiffTarget {
  switch (target.kind) {
    case "commit":
      return { kind: "commit", hash: target.hash };
    case "range":
      return { kind: "range", from: target.from, to: target.to, threeDot: target.threeDot };
    case "worktree":
      return { kind: "working-tree", base: "index" };
    case "index":
      return { kind: "index" };
    case "revisionToWorktree":
      return { kind: "working-tree", base: { revision: { rev: target.revision } } };
  }
}

/** What the files panel shows under its title. */
export function targetLabel(target: ReviewTarget): string {
  switch (target.kind) {
    case "commit":
      return shortHash(target.hash);
    case "range":
      return `${shortRev(target.from)}${target.threeDot ? "..." : ".."}${shortRev(target.to)}`;
    case "worktree":
    case "index":
      return "";
    case "revisionToWorktree":
      return `${shortRev(target.revision)}..`;
  }
}

/** A hash or a prefix of one: what a revision is when no ref carries its name. */
const HASH_LIKE = /^[0-9a-f]{4,64}$/i;

/** What `rev` points at as far as the refs listing tells (see `refsBehind`). */
function revisionBehind(rev: string, refs: Ref[]): string {
  const named = refs.filter((entry) => entry.name === rev || entry.fullName === rev);
  if (named.length > 0) return named.map((entry) => `${entry.fullName}=${entry.target}`).join(",");
  if (HASH_LIKE.test(rev)) return rev;
  return refs.map((entry) => `${entry.fullName}=${entry.target}`).join("|");
}

/**
 * What the refs a target names point at, as the refs listing tells, so that a change means
 * the change set may have changed: HEAD for the index, each end of a range, the revision
 * against the working tree. A ref's name or full name gives the targets of every ref so
 * named (git picks one of them), a hash gives itself, anything else (`main~2`) every ref's
 * target. Empty for the targets no ref moves: a commit, the working tree against the index.
 */
export function refsBehind(target: ReviewTarget, refs: Ref[]): string {
  switch (target.kind) {
    case "commit":
    case "worktree":
      return "";
    case "index":
      return revisionBehind("HEAD", refs);
    case "range":
      return `${revisionBehind(target.from, refs)};${revisionBehind(target.to, refs)}`;
    case "revisionToWorktree":
      return revisionBehind(target.revision, refs);
  }
}

/** A full hash is shown short; a ref name as typed. */
export function shortRev(rev: string): string {
  return /^[0-9a-f]{40}$/i.test(rev) ? shortHash(rev) : rev;
}

/** Content keys, computed once per hunk object. */
const hunkKeys = new WeakMap<Hunk, string>();

/**
 * The key a hunk's mark is stored under: a hash of its lines (kind, text and the missing
 * final newline), so the mark follows the lines when they move and drops when they change.
 */
export function hunkKey(hunk: Hunk): string {
  let key = hunkKeys.get(hunk);
  if (key === undefined) {
    const text = hunk.lines
      .map((line) => `${line.kind[0] ?? ""}${line.noNewline ? "\\" : ""}${line.text}`)
      .join("\n");
    key = `c:${hash53(text)}`;
    hunkKeys.set(hunk, key);
  }
  return key;
}

/** The key a hunk's mark had before marks held content: its position and its header. */
export function positionKey(hunk: Hunk): string {
  return `${hunk.oldStart},${hunk.newStart}:${hunk.header}`;
}

/**
 * The content a file mark holds: the ids of the file's two sides. Null when the new side
 * came without an id (a working tree file that could not be read), which no mark can hold; a
 * conflict's sides are index stages, which have none.
 */
export function contentOf(file: FileChange): string | null {
  const hasNewSide = file.status !== "deleted" && file.status !== "unmerged";
  if (hasNewSide && file.newId === null) return null;
  return `${file.oldId ?? "-"}:${file.newId ?? "-"}`;
}

/** The value of a mark written before marks held content, and of every hunk mark. */
const NO_CONTENT = "1";

/** cyrb53, a 53-bit string hash (public domain), in hex. */
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** The filters a review starts with, from the settings' "Hide by default". */
function filtersFrom(hide: {
  generated: boolean;
  lockfiles: boolean;
  tests: boolean;
}): FileFilters {
  return { hideGenerated: hide.generated, hideLockfiles: hide.lockfiles, hideTests: hide.tests };
}

export const useReviewStore = defineStore("review", () => {
  const repo = useRepoStore();
  const toasts = useToastsStore();

  /**
   * Says that a mark or a note could not be written, the change it made undone; one such toast
   * stands at a time, so a store that refuses every write says it once.
   */
  function writeFailed(key: string, path: string, failure: unknown): void {
    const error = toAppError(failure);
    toasts.push({
      kind: "error",
      message: "",
      key,
      params: { file: baseName(path) },
      output: error.detail ?? error.message,
      slot: "review-write",
    });
  }
  const settings = useSettingsStore();
  const operations = useOperationsStore();

  const filters = ref<FileFilters>(filtersFrom(settings.values.hideByDefault));
  const selectedPath = ref<string | null>(null);
  const revealed = ref(new Set<string>());
  /** Files read whole after a failed diff ("Show new file"), as one hunk of added lines. */
  const shown = ref(new Map<string, Hunk>());
  /** The target chosen explicitly; null follows the graph selection. */
  const chosenTarget = ref<ReviewTarget | null>(null);
  /**
   * The comparison's range while its tab shows: its files read it before the chosen target,
   * which it leaves as it was for review focus.
   */
  const comparisonTarget = ref<ReviewTarget | null>(null);
  /** The change set streamed for the chosen target (or for the commit with other options). */
  const ownChangeSet = shallowRef<ReviewChangeSet | null>(null);
  /**
   * The marks of each path: key to value. The empty key is the whole file, its value the
   * content it was marked for ("1" when marked before marks held content); hunk keys hold "1".
   */
  const marks = ref(new Map<string, Map<string, string>>());
  const notes = ref(new Map<string, string>());
  /** The resolution of a note by its path: the reply (possibly empty) and when, Unix seconds. */
  const resolutions = ref(new Map<string, NoteResolution>());
  /** Two pinned commits of the graph (its chips). */
  const diffBase = ref<string | null>(null);
  const rangeEnd = ref<string | null>(null);
  /** The changed symbol the keyboard landed on, for the status bar. */
  const currentSymbol = ref<string | null>(null);

  let streamHandle: StreamHandle | null = null;
  let streamSerial = 0;
  /** The operation of a restricted read in flight, cancelled when a whole one starts. */
  let restrictedOp: string | null = null;
  let annotationsSerial = 0;
  /** Local writes since the marks were last loaded; a load that raced one runs again. */
  let localWrites = 0;

  const layout = computed<DiffLayout>(() => settings.values.diffLayout);
  /** The viewer's tab stops (the settings' Diff section, "Tab width"). */
  const tabWidth = computed(() => settings.values.tabWidth);

  // "Hide by default" changed in the settings: the filters follow at once (the three flags
  // compared by value, so an unrelated settings write leaves the review's own toggles alone).
  watch(
    () => {
      const hide = settings.values.hideByDefault;
      return `${hide.generated}/${hide.lockfiles}/${hide.tests}`;
    },
    () => {
      filters.value = filtersFrom(settings.values.hideByDefault);
    },
  );
  const wrap = computed(() => settings.values.diffWrap);
  const ignoreWhitespace = computed(() => settings.values.diffIgnoreWhitespace);
  const wholeFile = computed(() => settings.values.diffWholeFile);

  const target = computed<ReviewTarget | null>(() => {
    if (comparisonTarget.value) return comparisonTarget.value;
    if (chosenTarget.value) return chosenTarget.value;
    const hash = repo.selectedCommit?.hash;
    return hash ? { kind: "commit", hash } : null;
  });
  const key = computed(() => (target.value ? targetKey(target.value) : null));

  /** Whether the store streams its own change set rather than reading the graph's detail. */
  const ownStream = computed(
    () => comparisonTarget.value !== null || chosenTarget.value !== null || ignoreWhitespace.value,
  );

  const changeSet = computed<ReviewChangeSet | null>(() => {
    if (ownStream.value) return ownChangeSet.value;
    const detail = repo.detail;
    if (!detail) return null;
    return {
      files: detail.files,
      additions: detail.additions,
      deletions: detail.deletions,
      totalFiles: detail.totalFiles,
      loading: detail.loading,
      ...(detail.error ? { error: detail.error } : {}),
    };
  });
  const files = computed(() => changeSet.value?.files ?? []);

  const fileByPath = computed(() => new Map(files.value.map((file) => [file.path, file])));
  /** A commit's diff cannot change: marks with no content still count on it. */
  const fixedContent = computed(() => target.value?.kind === "commit");

  /** How the whole-file mark of `file` reads against the content it shows now. */
  function fileMark(file: FileChange): "reviewed" | "changed" | "none" {
    const value = marks.value.get(file.path)?.get("");
    if (value === undefined) return "none";
    const content = contentOf(file);
    if (content !== null && value === content) return "reviewed";
    if (value === NO_CONTENT) return fixedContent.value ? "reviewed" : "none";
    return "changed";
  }

  function hunkMarked(path: string, hunk: Hunk): boolean {
    const set = marks.value.get(path);
    if (!set) return false;
    return set.has(hunkKey(hunk)) || (fixedContent.value && set.has(positionKey(hunk)));
  }

  /** Files whose mark holds the content they show, or with every hunk marked. */
  const reviewedFiles = computed(() => {
    const done = new Set<string>();
    for (const file of files.value) {
      if (!marks.value.has(file.path)) continue;
      if (fileMark(file) === "reviewed") {
        done.add(file.path);
        continue;
      }
      if (file.hunks.length > 0 && file.hunks.every((hunk) => hunkMarked(file.path, hunk))) {
        done.add(file.path);
      }
    }
    return done;
  });
  const reviewedCount = computed(() => reviewedFiles.value.size);
  /** Files marked for another content than they show: reviewed, then changed. */
  const changedFiles = computed(() => {
    const changed = new Set<string>();
    for (const file of files.value) {
      if (!reviewedFiles.value.has(file.path) && fileMark(file) === "changed") {
        changed.add(file.path);
      }
    }
    return changed;
  });
  const changedCount = computed(() => changedFiles.value.size);

  function isReviewed(path: string): boolean {
    return reviewedFiles.value.has(path);
  }

  function isChanged(path: string): boolean {
    return changedFiles.value.has(path);
  }

  function isHunkReviewed(path: string, hunk: Hunk): boolean {
    const file = fileByPath.value.get(path);
    if (file && fileMark(file) === "reviewed") return true;
    return hunkMarked(path, hunk);
  }

  function setFilter<K extends keyof FileFilters>(key: K, value: boolean): void {
    filters.value = { ...filters.value, [key]: value };
  }

  function select(path: string | null): void {
    selectedPath.value = path;
    currentSymbol.value = null;
  }

  function reveal(path: string): void {
    revealed.value = new Set(revealed.value).add(path);
  }

  /** The hunk "Show new file" produced for `path`, when the change set failed. */
  function shownHunk(path: string): Hunk | null {
    return changeSet.value?.error ? (shown.value.get(path) ?? null) : null;
  }

  /**
   * Reads `file` whole on its new side and shows it as added lines: the escape hatch of a
   * change set the engine could not compute.
   */
  async function showNewFile(file: FileChange): Promise<void> {
    const current = target.value;
    const root = repo.repo?.root;
    if (!current || !root) return;
    const side = fileSides(current, file).new;
    if (!side) return;
    try {
      const blob = await ipc.readBlob(root, side.at, side.path, newOpId("blob"));
      const lines = (blob.text ?? "").replace(/\n$/, "").split("\n");
      const added: DiffLine[] = lines.map((text, i) => ({
        kind: "added",
        oldNumber: null,
        newNumber: i + 1,
        text,
        spans: [],
        noNewline: false,
      }));
      const hunk: Hunk = {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: added.length,
        header: `@@ -0,0 +1,${added.length} @@`,
        lines: added,
      };
      shown.value = new Map(shown.value).set(file.path, hunk);
    } catch {
      shown.value = new Map(shown.value);
      shown.value.delete(file.path);
    }
  }

  /**
   * Opens the review on `file` of the current target, lifting the filter that would hide it.
   * With a hash, the selected commit becomes the target when another was chosen.
   */
  function open(hash: string | null, file: FileChange | null): void {
    if (hash && chosenTarget.value && targetKey(chosenTarget.value) !== hash) {
      setTarget(null);
    }
    if (!file) return;
    if (isLockfile(file.path)) {
      if (filters.value.hideLockfiles) setFilter("hideLockfiles", false);
    } else if (file.isGenerated && filters.value.hideGenerated) {
      setFilter("hideGenerated", false);
    }
    if (file.isTest && filters.value.hideTests) setFilter("hideTests", false);
    selectedPath.value = file.path;
  }

  function stopStream(): void {
    streamSerial += 1;
    void streamHandle?.cancel();
    streamHandle = null;
    if (restrictedOp !== null) {
      void ipc.cancelOperation(restrictedOp).catch(() => undefined);
      restrictedOp = null;
    }
  }

  /** The own change set's reloads, one at a time: whole, or at the paths that changed. */
  const reloader = new Reloader({ full: () => loadOwn(), paths: (paths) => readOwnAt(paths) });

  /** Streams the own change set again whole, which replaces the reloads that waited. */
  function restartOwn(): void {
    reloader.request({ kind: "full" });
  }

  /** Streams the change set of the current target with the current options. */
  function loadOwn(): Promise<void> {
    stopStream();
    const current = target.value;
    const root = repo.repo?.root;
    if (!current || !root) {
      ownChangeSet.value = null;
      return Promise.resolve();
    }
    const serial = streamSerial;
    const opId = newOpId("review");
    ownChangeSet.value = {
      files: [],
      additions: 0,
      deletions: 0,
      totalFiles: 0,
      loading: true,
    };
    operations.start(opId, "operations.computingDiff");
    const handle = ipc.diff(
      root,
      diffTargetOf(current),
      (page: DiffPage) => {
        if (serial !== streamSerial || !ownChangeSet.value) return;
        ownChangeSet.value = {
          ...ownChangeSet.value,
          files: ownChangeSet.value.files.concat(page.files),
          additions: page.additions,
          deletions: page.deletions,
          totalFiles: page.totalFiles,
        };
      },
      { ...ipc.defaultDiffOptions, ignoreWhitespace: ignoreWhitespace.value },
      opId,
    );
    streamHandle = handle;
    return handle.done
      .then(() => {
        if (serial === streamSerial && ownChangeSet.value) {
          ownChangeSet.value = { ...ownChangeSet.value, loading: false };
        }
      })
      .catch((error: unknown) => {
        if (serial === streamSerial && ownChangeSet.value) {
          ownChangeSet.value = {
            ...ownChangeSet.value,
            loading: false,
            error: toAppError(error),
          };
        }
      })
      .finally(() => operations.finish(opId));
  }

  /**
   * Reads the own change set again at the paths that changed and merges the result into it;
   * false when it must be read whole instead (too many paths or files, a failed read).
   */
  async function readOwnAt(changed: string[]): Promise<boolean> {
    const current = target.value;
    const root = repo.repo?.root;
    const set = ownChangeSet.value;
    if (!current || !root || !set || !ownStream.value) return true;
    if (set.error) return false;
    const serial = streamSerial;
    // Another target or a whole reload since holds the newer change set.
    const superseded = () => serial !== streamSerial || !ownChangeSet.value;
    const read = async (paths: string[]) => {
      if (paths.length > MAX_RESTRICTED_PATHS || paths.some(unspellable)) return null;
      const opId = newOpId("review");
      restrictedOp = opId;
      try {
        return await ipc.diffPaths(
          root,
          diffTargetOf(current),
          paths,
          { ...ipc.defaultDiffOptions, ignoreWhitespace: ignoreWhitespace.value },
          opId,
        );
      } catch {
        return null;
      } finally {
        if (restrictedOp === opId) restrictedOp = null;
      }
    };
    let requested = requestedPaths(set.files, changed);
    let result = await read(requested);
    if (superseded()) return true;
    if (result === null) return false;
    // The working tree against the index pairs no rename; the others read again with the
    // listed files a touched addition, deletion or rename may pair with.
    if (current.kind !== "worktree") {
      const extra = pairingPaths(set.files, requested, result.files);
      if (extra.length > 0) {
        requested = [...new Set([...requested, ...extra])];
        result = await read(requested);
        if (superseded()) return true;
        if (result === null) return false;
      }
    }
    if (!ownChangeSet.value) return true;
    const files = mergeRestricted(ownChangeSet.value.files, requested, result.files);
    ownChangeSet.value = {
      ...ownChangeSet.value,
      files,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      totalFiles: files.length,
    };
    return true;
  }

  /** Chooses what review focus shows; null returns to the graph's selection. */
  function setTarget(next: ReviewTarget | null): void {
    const before = key.value;
    chosenTarget.value = next;
    retarget(before);
  }

  /** The comparison's range while its tab shows; null when it leaves. */
  function setComparisonTarget(next: ReviewTarget | null): void {
    const before = key.value;
    comparisonTarget.value = next;
    retarget(before);
  }

  /** Another target: a new key starts with no file open, and the own stream follows it. */
  function retarget(before: string | null): void {
    if (key.value !== before) {
      selectedPath.value = null;
      revealed.value = new Set();
      shown.value = new Map();
      currentSymbol.value = null;
    }
    if (ownStream.value) restartOwn();
    else {
      reloader.clear();
      stopStream();
      ownChangeSet.value = null;
    }
  }

  /** Computes the change set again (the watcher reported a change, or an option moved). */
  function reload(): void {
    if (ownStream.value) restartOwn();
    else if (repo.selectedIndex >= 0) repo.select(repo.selectedIndex);
  }

  /**
   * The targets that involve the working tree or the index follow the watcher, reading again
   * what the change moved (`reloads.ts`); a commit or a range does not change.
   */
  function onRepoChanged(change: RepoChanged): void {
    const current = target.value;
    if (!current || !ownStream.value) return;
    const worktree = current.kind === "worktree" || current.kind === "revisionToWorktree";
    if (!worktree && current.kind !== "index") return;
    reloader.request(reloadFor(change, worktree));
  }

  // A target named by refs (the index against HEAD, `base..HEAD`, a revision against the
  // working tree) follows them: when the refs listing moves what the same target names, the
  // change set is computed again. A branch moving elsewhere leaves it alone, and choosing
  // another target loads that one already.
  const behind = computed(() =>
    target.value && repo.refsLoaded ? refsBehind(target.value, repo.refs) : null,
  );
  watch([key, behind], ([nowKey, now], [beforeKey, before]) => {
    if (nowKey !== beforeKey || now === null || before === null || now === before) return;
    reload();
  });

  async function setLayout(next: DiffLayout): Promise<void> {
    await settings.update("diffLayout", next);
  }

  async function setWrap(next: boolean): Promise<void> {
    await settings.update("diffWrap", next);
  }

  async function setWholeFile(next: boolean): Promise<void> {
    await settings.update("diffWholeFile", next);
  }

  async function setIgnoreWhitespace(next: boolean): Promise<void> {
    if (next === ignoreWhitespace.value) return;
    await settings.update("diffIgnoreWhitespace", next);
    // With a chosen target the stream restarts here; a followed commit restarts through the
    // watcher below when the own stream switches on.
    if (comparisonTarget.value || chosenTarget.value) restartOwn();
    else if (!ownStream.value) {
      stopStream();
      ownChangeSet.value = null;
    }
  }

  // --- Marks and notes -----------------------------------------------------------------

  function marksOf(path: string): Map<string, string> {
    return new Map(marks.value.get(path) ?? []);
  }

  function replaceMarks(path: string, set: Map<string, string>): void {
    const next = new Map(marks.value);
    if (set.size === 0) next.delete(path);
    else next.set(path, set);
    marks.value = next;
    localWrites += 1;
  }

  /** Writes a mark through the IPC; a failure reverts the optimistic change. */
  function persistMark(
    path: string,
    hunk: string,
    on: boolean,
    revert: () => void,
    value = NO_CONTENT,
  ): void {
    const root = repo.repo?.root;
    const current = key.value;
    if (!root || !current) return;
    const write = { path, hunk, kind: "reviewed" as const, value };
    const call = on
      ? ipc.setAnnotation(root, current, write)
      : ipc.deleteAnnotation(root, current, write);
    void call.catch((failure: unknown) => {
      revert();
      writeFailed("review.markFailed", path, failure);
    });
  }

  /** Marks the file for the content it shows, or clears every mark of a reviewed one. */
  function toggleReviewed(path: string): void {
    const file = fileByPath.value.get(path);
    const before = marksOf(path);
    const set = marksOf(path);
    const on = file ? fileMark(file) !== "reviewed" : !set.has("");
    if (on) {
      const content = file ? contentOf(file) : NO_CONTENT;
      // Content that is not known cannot be marked; the reload after the change brings it.
      if (content === null) return;
      set.set("", content);
      replaceMarks(path, set);
      persistMark(path, "", true, () => replaceMarks(path, before), content);
      return;
    }
    set.clear();
    replaceMarks(path, set);
    persistMark(path, "", false, () => replaceMarks(path, before));
    // Unmarking a file marked hunk by hunk clears its hunks too.
    for (const hunk of before.keys()) if (hunk !== "") persistMark(path, hunk, false, () => {});
  }

  function toggleHunkReviewed(path: string, hunk: Hunk): void {
    const file = fileByPath.value.get(path);
    const before = marksOf(path);
    const set = marksOf(path);
    const hunkId = hunkKey(hunk);
    const wholeFile = file !== undefined && fileMark(file) === "reviewed";
    const on = !(hunkMarked(path, hunk) || wholeFile);
    if (on) {
      set.set(hunkId, NO_CONTENT);
      // The last hunk marked makes it a file mark too, holding the content, so the file shows
      // "changed since review" when that content moves on.
      const content = file ? contentOf(file) : null;
      if (file && content !== null && file.hunks.every((other) => set.has(hunkKey(other)))) {
        set.set("", content);
        persistMark(path, "", true, () => {}, content);
      }
    } else {
      set.delete(hunkId);
      // A mark from before marks held content, on a commit.
      const legacy = positionKey(hunk);
      if (set.delete(legacy)) persistMark(path, legacy, false, () => {});
      if (wholeFile) {
        // Unmarking one hunk of a file marked whole leaves the other hunks marked.
        set.delete("");
        for (const other of file.hunks) {
          const otherKey = hunkKey(other);
          if (otherKey !== hunkId) {
            set.set(otherKey, NO_CONTENT);
            persistMark(path, otherKey, true, () => {});
          }
        }
        persistMark(path, "", false, () => {});
      }
    }
    replaceMarks(path, set);
    persistMark(path, hunkId, on, () => replaceMarks(path, before));
  }

  /**
   * Writes, replaces or (with no text) deletes the note on `path`. Another text is another
   * note: the old one's resolution goes, as the store drops it.
   */
  function setNote(path: string, text: string | null): void {
    const root = repo.repo?.root;
    const current = key.value;
    const before = notes.value.get(path);
    const resolutionBefore = resolutions.value.get(path);
    const next = new Map(notes.value);
    const trimmed = text?.trim() ?? "";
    if (trimmed === "") next.delete(path);
    else next.set(path, trimmed);
    notes.value = next;
    if (trimmed !== before && resolutionBefore) {
      const unresolved = new Map(resolutions.value);
      unresolved.delete(path);
      resolutions.value = unresolved;
    }
    localWrites += 1;
    if (!root || !current) return;
    const revert = () => {
      const restored = new Map(notes.value);
      if (before === undefined) restored.delete(path);
      else restored.set(path, before);
      notes.value = restored;
      if (resolutionBefore) {
        const resolved = new Map(resolutions.value);
        resolved.set(path, resolutionBefore);
        resolutions.value = resolved;
      }
    };
    const write = { path, hunk: "", kind: "note" as const, value: trimmed };
    const call =
      trimmed === ""
        ? ipc.deleteAnnotation(root, current, write)
        : ipc.setAnnotation(root, current, write);
    void call.catch((failure: unknown) => {
      revert();
      writeFailed("review.noteFailed", path, failure);
    });
  }

  /** Removes the resolution of the note on `path`, which shows open again. */
  function reopenNote(path: string): void {
    const before = resolutions.value.get(path);
    if (!before) return;
    const next = new Map(resolutions.value);
    next.delete(path);
    resolutions.value = next;
    localWrites += 1;
    const root = repo.repo?.root;
    const current = key.value;
    if (!root || !current) return;
    void ipc
      .deleteAnnotation(root, current, { path, hunk: "", kind: "resolved", value: "" })
      .catch((failure: unknown) => {
        const restored = new Map(resolutions.value);
        restored.set(path, before);
        resolutions.value = restored;
        writeFailed("review.reopenFailed", path, failure);
      });
  }

  /**
   * Loads the marks, notes and resolutions of the current target. A target's first load
   * empties what showed before; `refresh` (the window gaining the focus) keeps it until the
   * new list replaces it, so nothing flickers.
   */
  async function loadAnnotations(retry = true, refresh = false): Promise<void> {
    annotationsSerial += 1;
    const serial = annotationsSerial;
    const writesBefore = localWrites;
    if (!refresh) {
      marks.value = new Map();
      notes.value = new Map();
      resolutions.value = new Map();
    }
    const root = repo.repo?.root;
    const current = key.value;
    if (!root || !current) return;
    try {
      const listed = await ipc.listAnnotations(root, current);
      if (serial !== annotationsSerial) return;
      if (localWrites !== writesBefore) {
        // A mark or note was written while the list was in flight: read once more so the
        // list holds it, rather than overwriting the local state with a stale one.
        if (retry) await loadAnnotations(false, refresh);
        return;
      }
      const nextMarks = new Map<string, Map<string, string>>();
      const nextNotes = new Map<string, string>();
      const nextResolutions = new Map<string, NoteResolution>();
      for (const annotation of listed) {
        if (annotation.kind === "reviewed") {
          const set = nextMarks.get(annotation.path) ?? new Map<string, string>();
          set.set(annotation.hunk, annotation.value);
          nextMarks.set(annotation.path, set);
        } else if (annotation.hunk !== "") {
          // Notes and resolutions on hunks are written by nothing.
        } else if (annotation.kind === "note") {
          nextNotes.set(annotation.path, annotation.value);
        } else {
          nextResolutions.set(annotation.path, {
            reply: annotation.value,
            at: annotation.updatedAt,
          });
        }
      }
      marks.value = nextMarks;
      notes.value = nextNotes;
      resolutions.value = nextResolutions;
    } catch {
      // The marks stay as they were for this target; writes still go through.
    }
  }

  /** Reads the marks and notes again, keeping what shows: an agent may have written. */
  function refreshAnnotations(): void {
    void loadAnnotations(true, true);
  }

  function setDiffBase(hash: string | null): void {
    diffBase.value = hash;
  }

  function setRangeEnd(hash: string | null): void {
    rangeEnd.value = hash;
  }

  /** Forgets both pinned commits (another repository opened). */
  function clearPins(): void {
    diffBase.value = null;
    rangeEnd.value = null;
  }

  // The marks and notes follow the target; the selection is reset per target above.
  watch(
    () => [repo.repo?.root, key.value] as const,
    () => void loadAnnotations(),
    { immediate: true },
  );

  // Another repository: the chosen target and the own stream go.
  watch(
    () => repo.repo?.root,
    () => {
      stopStream();
      chosenTarget.value = null;
      ownChangeSet.value = null;
      selectedPath.value = null;
      revealed.value = new Set();
      shown.value = new Map();
      currentSymbol.value = null;
    },
  );

  // A commit chosen through the graph while whitespace is ignored streams its own diff.
  watch(
    () => [repo.selectedCommit?.hash, ownStream.value] as const,
    ([, own]) => {
      if (own && chosenTarget.value === null && comparisonTarget.value === null) restartOwn();
    },
  );

  return {
    filters,
    selectedPath,
    revealed,
    target,
    chosenTarget,
    comparisonTarget,
    setComparisonTarget,
    key,
    changeSet,
    files,
    marks,
    notes,
    resolutions,
    reviewedFiles,
    reviewedCount,
    changedFiles,
    changedCount,
    layout,
    tabWidth,
    wrap,
    ignoreWhitespace,
    wholeFile,
    diffBase,
    rangeEnd,
    currentSymbol,
    isReviewed,
    isChanged,
    isHunkReviewed,
    setFilter,
    select,
    reveal,
    shownHunk,
    showNewFile,
    open,
    setTarget,
    reload,
    onRepoChanged,
    setLayout,
    setWrap,
    setIgnoreWhitespace,
    setWholeFile,
    toggleReviewed,
    toggleHunkReviewed,
    setNote,
    reopenNote,
    loadAnnotations,
    refreshAnnotations,
    setDiffBase,
    setRangeEnd,
    clearPins,
  };
});
