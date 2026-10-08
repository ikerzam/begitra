// Typed client of every Tauri command. Non-streaming commands return validated results;
// paged ones return a `StreamHandle` (see `stream.ts`). Every function takes an optional
// `opId` so callers can cancel through `cancelOperation`.

import * as v from "valibot";

import { call, newOpId } from "./invoke";
import {
  AnnotationSchema,
  BlobContentSchema,
  ComparisonSchema,
  GitDetectionSchema,
  MergePreviewSchema,
  CommitContextSchema,
  CommitCountSchema,
  CommitResultSchema,
  ConflictSchema,
  CleanupCandidatesSchema,
  DeleteOutcomeSchema,
  type BranchToDelete,
  type MergeMode,
  type NetworkEvent,
  NetworkEventSchema,
  OperationSidesSchema,
  OperationStateSchema,
  OutcomeSchema,
  type PullRequest,
  type PushRequest,
  RemoteSchema,
  type ResetMode,
  type SequencerAction,
  type Side,
  type StashPush,
  type SwitchTarget,
  ChangeSetSchema,
  DiffPageSchema,
  HighlightSchema,
  IndexEntrySchema,
  PongSchema,
  ProjectEditSchema,
  ProjectOpenSchema,
  ProjectSchema,
  AppInfoSchema,
  RefSchema,
  RepoSchema,
  ScanMessageSchema,
  StatusEntrySchema,
  SymbolSchema,
  WalkPageSchema,
  WorktreeSchema,
  IgnoreOutcomeSchema,
  DiscardCopySchema,
  UndoOutcomeSchema,
  type AnnotationWrite,
  type BlobAt,
  type CommitRequest,
  type PatchSelection,
  type SelectionTarget,
  type DiffOptions,
  type DiffPage,
  type DiffTarget,
  type IgnorePlace,
  type IgnoreRule,
  type LineRange,
  type RepoChanged,
  type ScanMessage,
  type ScanOptions,
  type StatusOptions,
  type WalkOptions,
  type WalkPage,
  type WalkScope,
  type WorktreeAdd,
} from "./schemas";
import { stream, type StreamHandle } from "./stream";

export const defaultWalkOptions: WalkOptions = { pageSize: 500, order: "lazy" };
export const defaultStatusOptions: StatusOptions = {
  includeIgnored: false,
  includeUntracked: true,
  renames: true,
};
export const defaultDiffOptions: DiffOptions = {
  renames: true,
  similarity: 50,
  context: 3,
  intraLine: true,
  ignoreWhitespace: false,
};

export function ping(message: string) {
  return call("ping", { message }, PongSchema);
}

/** The version and where the log is written. */
export function appInfo() {
  return call("app_info", {}, AppInfoSchema);
}

export function cancelOperation(opId: string) {
  return call("cancel_operation", { opId }, v.boolean());
}

export function debugEmitRepoChanged(payload: RepoChanged) {
  return call("debug_emit_repo_changed", { payload }, v.null());
}

export function openRepository(path: string, opId = newOpId("open")) {
  return call("open_repository", { path, opId }, RepoSchema);
}

export function closeRepository(root: string) {
  return call("close_repository", { root }, v.boolean());
}

export function listRefs(repo: string, opId = newOpId("refs")) {
  return call("list_refs", { repo, opId }, v.array(RefSchema));
}

export function status(
  repo: string,
  options: StatusOptions = defaultStatusOptions,
  opId = newOpId("status"),
) {
  return call("status", { repo, options, opId }, v.array(StatusEntrySchema));
}

export function mergeBase(repo: string, a: string, b: string, opId = newOpId("merge-base")) {
  return call("merge_base", { repo, a, b, opId }, v.string());
}

/** The merge base, the counts of commits only on each side and the relation of two revisions. */
export function compare(repo: string, a: string, b: string, opId = newOpId("compare")) {
  return call("compare", { repo, a, b, opId }, ComparisonSchema);
}

/** What merging `b` into `a` would do; never changes a ref, the index or a working tree. */
export function mergePreview(repo: string, a: string, b: string, opId = newOpId("preview")) {
  return call("merge_preview", { repo, a, b, opId }, MergePreviewSchema);
}

/** How many commits a scope holds (capped at 100,000 with `capped` set). */
export function countCommits(repo: string, scope: WalkScope, opId = newOpId("count")) {
  return call("count_commits", { repo, scope, opId }, CommitCountSchema);
}

/** Stages paths (`git add -A` on literal pathspecs). */
export function stagePaths(repo: string, paths: string[], opId = newOpId("stage")) {
  return call("stage_paths", { repo, paths, opId }, v.null());
}

/** Unstages paths (`git reset -q` on literal pathspecs); the working tree stays. */
export function unstagePaths(repo: string, paths: string[], opId = newOpId("unstage")) {
  return call("unstage_paths", { repo, paths, opId }, v.null());
}

/**
 * Discards the unstaged changes of tracked paths and removes untracked ones. With `keepCopy`,
 * the paths are copied first for the discard's Undo (ADR-0020), and a copy that cannot be kept
 * refuses the discard (`discard.too_large`, `discard.not_a_file`, `discard.copy_failed`).
 */
export function discardPaths(
  repo: string,
  tracked: string[],
  untracked: string[],
  keepCopy: boolean,
  opId = newOpId("discard"),
) {
  return call("discard_paths", { repo, tracked, untracked, keepCopy, opId }, DiscardCopySchema);
}

/** Writes back what a discard kept as `copy`: each path that still holds what it left. */
export function undoDiscard(repo: string, copy: string, opId = newOpId("undo-discard")) {
  return call("undo_discard", { repo, copy, opId }, UndoOutcomeSchema);
}

/** Removes the copy a discard kept; a copy already gone is fine. */
export function forgetDiscard(copy: string, opId = newOpId("forget-discard")) {
  return call("forget_discard", { copy, opId }, v.null());
}

/**
 * Writes an ignore rule for an untracked path, one line in `.gitignore` or `.git/info/exclude`
 * (ADR-0020), and says whether git then ignores it.
 */
export function ignorePath(
  repo: string,
  path: string,
  rule: IgnoreRule,
  place: IgnorePlace,
  opId = newOpId("ignore"),
) {
  return call("ignore_path", { repo, path, rule, place, opId }, IgnoreOutcomeSchema);
}

/**
 * Applies a selection of hunks and lines to the index or the working tree; a discard with
 * `keepCopy` copies the file first, as `discardPaths` does.
 */
export function applySelection(
  repo: string,
  target: SelectionTarget,
  selection: PatchSelection,
  keepCopy: boolean,
  opId = newOpId("apply-selection"),
) {
  return call("apply_selection", { repo, target, selection, keepCopy, opId }, DiscardCopySchema);
}

/** Commits the index; hooks run; the call cannot be cancelled. */
export function commit(repo: string, request: CommitRequest, opId = newOpId("commit")) {
  return call("commit", { repo, request, opId }, CommitResultSchema);
}

/** The author, the template, HEAD's message and whether HEAD is unborn. */
export function commitContext(repo: string, opId = newOpId("commit-context")) {
  return call("commit_context", { repo, opId }, CommitContextSchema);
}

// --- Branches, the sequencer, remotes and the stash -----------------------------------------

/** Creates a branch at `start`, checking it out when `checkout`. */
export function branchCreate(
  repo: string,
  name: string,
  start: string,
  checkout: boolean,
  track = false,
  opId = newOpId("branch-create"),
) {
  return call("branch_create", { repo, name, start, checkout, track, opId }, v.null());
}

/** Switches to a branch or a detached revision; a dirty switch is git's refusal. */
export function switchTo(repo: string, target: SwitchTarget, opId = newOpId("switch")) {
  return call("switch", { repo, target, opId }, v.null());
}

export function branchRename(repo: string, from: string, to: string, opId = newOpId("rename")) {
  return call("branch_rename", { repo, from, to, opId }, v.null());
}

/** Deletes a branch; an unmerged one needs `force`. */
export function branchDelete(
  repo: string,
  name: string,
  force: boolean,
  opId = newOpId("branch-delete"),
) {
  return call("branch_delete", { repo, name, force, opId }, v.null());
}

/** Merges `rev` into HEAD; a stop on conflicts is an outcome. */
export function merge(repo: string, rev: string, mode: MergeMode, opId = newOpId("merge")) {
  return call("merge", { repo, rev, mode, opId }, OutcomeSchema);
}

export function rebase(repo: string, onto: string, opId = newOpId("rebase")) {
  return call("rebase", { repo, onto, opId }, OutcomeSchema);
}

export function reset(repo: string, rev: string, mode: ResetMode, opId = newOpId("reset")) {
  return call("reset", { repo, rev, mode, opId }, v.null());
}

/**
 * Moves HEAD from `from` to `to` as a soft reset does, only while HEAD is still `from` on
 * `branch` (its full ref name; null when detached), `refs.head_moved` otherwise: the undo of
 * HEAD's commit and its redo.
 */
export function moveHead(
  repo: string,
  from: string,
  to: string,
  branch: string | null,
  opId = newOpId("move-head"),
) {
  return call("move_head", { repo, from, to, branch, opId }, v.null());
}

export function cherryPick(repo: string, revs: string[], opId = newOpId("cherry-pick")) {
  return call("cherry_pick", { repo, revs, opId }, OutcomeSchema);
}

export function revert(repo: string, revs: string[], opId = newOpId("revert")) {
  return call("revert", { repo, revs, opId }, OutcomeSchema);
}

/** Creates a tag at `rev`, annotated with `message` when given. */
export function tagCreate(
  repo: string,
  name: string,
  rev: string,
  message: string | null,
  opId = newOpId("tag-create"),
) {
  return call("tag_create", { repo, name, rev, message, opId }, v.null());
}

/** Deletes a tag; answers what it pointed at (an annotated tag's object), null when unknown. */
export function tagDelete(repo: string, name: string, opId = newOpId("tag-delete")) {
  return call("tag_delete", { repo, name, opId }, v.nullable(v.string()));
}

/** Sets a branch's upstream (`remote/branch`), or unsets it with null. */
export function setUpstream(
  repo: string,
  branch: string,
  upstream: string | null,
  opId = newOpId("upstream"),
) {
  return call("set_upstream", { repo, branch, upstream, opId }, v.null());
}

export function operationState(repo: string, opId = newOpId("operation")) {
  return call("operation_state", { repo, opId }, OperationStateSchema);
}

export function conflicts(repo: string, opId = newOpId("conflicts")) {
  return call("conflicts", { repo, opId }, v.array(ConflictSchema));
}

/** Marks conflicted paths resolved (`git add`). */
export function markResolved(repo: string, paths: string[], opId = newOpId("resolved")) {
  return call("mark_resolved", { repo, paths, opId }, v.null());
}

/** The names of the operation's two sides; null while no operation is in progress. */
export function operationSides(repo: string, opId = newOpId("sides")) {
  return call("operation_sides", { repo, opId }, v.nullable(OperationSidesSchema));
}

/**
 * Takes conflicted paths whole from one side, resolved: its version, or the file deleted where
 * that side has none.
 */
export function takeSide(repo: string, paths: string[], side: Side, opId = newOpId("take-side")) {
  return call("take_side", { repo, paths, side, opId }, v.null());
}

/** Puts back the conflicts of paths resolved during the operation in progress. */
export function restoreConflicts(
  repo: string,
  paths: string[],
  opId = newOpId("restore-conflicts"),
) {
  return call("restore_conflicts", { repo, paths, opId }, v.null());
}

/** The local branches that can go against the main branch. */
export function cleanupCandidates(repo: string, opId = newOpId("cleanup")) {
  return call("cleanup_candidates", { repo, opId }, CleanupCandidatesSchema);
}

/**
 * Deletes each branch with its worktree while its tip is still the one listed; answers each
 * one's outcome, in order.
 */
export function deleteBranches(
  repo: string,
  branches: BranchToDelete[],
  opId = newOpId("delete-branches"),
) {
  return call("delete_branches", { repo, branches, opId }, v.array(DeleteOutcomeSchema));
}

/** Continues, skips or aborts the operation in progress. */
export function sequencer(repo: string, action: SequencerAction, opId = newOpId("sequencer")) {
  return call("sequencer", { repo, action, opId }, OutcomeSchema);
}

export function remotes(repo: string, opId = newOpId("remotes")) {
  return call("remotes", { repo, opId }, v.array(RemoteSchema));
}

export function remoteAdd(repo: string, name: string, url: string, opId = newOpId("remote-add")) {
  return call("remote_add", { repo, name, url, opId }, v.null());
}

export function remoteRemove(repo: string, name: string, opId = newOpId("remote-remove")) {
  return call("remote_remove", { repo, name, opId }, v.null());
}

/**
 * Fetches (every remote when `remote` is null), git's progress lines as pages. In a `batch`
 * (an operation over many repositories) nothing may ask for a sign-in.
 */
export function fetch(
  repo: string,
  remote: string | null,
  prune: boolean,
  onEvent: (event: NetworkEvent, seq: number) => void,
  opId?: string,
  batch = false,
): StreamHandle {
  return stream("fetch", { repo, remote, prune, batch }, NetworkEventSchema, onEvent, opId);
}

/** Pulls with the progress streamed; the last page carries the outcome. */
export function pull(
  repo: string,
  request: PullRequest,
  onEvent: (event: NetworkEvent, seq: number) => void,
  opId?: string,
  batch = false,
): StreamHandle {
  return stream("pull", { repo, request, batch }, NetworkEventSchema, onEvent, opId);
}

/** Pushes with the progress streamed; the last page carries git's ref lines. */
export function push(
  repo: string,
  request: PushRequest,
  onEvent: (event: NetworkEvent, seq: number) => void,
  opId?: string,
  batch = false,
): StreamHandle {
  return stream("push", { repo, request, batch }, NetworkEventSchema, onEvent, opId);
}

/** Stashes the working tree or the given paths; false when there was nothing to save. */
export function stashPush(repo: string, request: StashPush, opId = newOpId("stash-push")) {
  return call("stash_push", { repo, request, opId }, v.boolean());
}

/** The stash is named by its commit, which a stash made or dropped elsewhere does not move. */
export function stashApply(repo: string, stash: string, opId = newOpId("stash-apply")) {
  return call("stash_apply", { repo, stash, opId }, OutcomeSchema);
}

/** The stash is named by its commit, which a stash made or dropped elsewhere does not move. */
export function stashPop(repo: string, stash: string, opId = newOpId("stash-pop")) {
  return call("stash_pop", { repo, stash, opId }, OutcomeSchema);
}

/** The stash is named by its commit, which a stash made or dropped elsewhere does not move. */
export function stashDrop(repo: string, stash: string, opId = newOpId("stash-drop")) {
  return call("stash_drop", { repo, stash, opId }, v.null());
}

export function listWorktrees(repo: string, opId = newOpId("worktrees")) {
  return call("list_worktrees", { repo, opId }, v.array(WorktreeSchema));
}

/** Adds a worktree through `git worktree add`; resolves with its entry. */
export function worktreeAdd(repo: string, request: WorktreeAdd, opId = newOpId("worktree-add")) {
  return call("worktree_add", { repo, request, opId }, WorktreeSchema);
}

/** Removes a linked worktree; without `force` a dirty one fails with `worktree.dirty`. */
export function worktreeRemove(
  repo: string,
  path: string,
  force: boolean,
  opId = newOpId("worktree-remove"),
) {
  return call("worktree_remove", { repo, path, force, opId }, v.null());
}

/** Unregisters the worktrees whose folders are gone; resolves with the paths that went. */
export function worktreePrune(repo: string, opId = newOpId("worktree-prune")) {
  return call("worktree_prune", { repo, opId }, v.array(v.string()));
}

export function worktreeLock(
  repo: string,
  path: string,
  reason: string | null,
  opId = newOpId("worktree-lock"),
) {
  return call("worktree_lock", { repo, path, reason, opId }, v.null());
}

export function worktreeUnlock(repo: string, path: string, opId = newOpId("worktree-unlock")) {
  return call("worktree_unlock", { repo, path, opId }, v.null());
}

/** Whether an absolute path exists (the add dialog checks its Path field with it). */
export function pathExists(path: string) {
  return call("path_exists", { path }, v.boolean());
}

/** Looks for git on PATH and in the platform's common locations. */
export function detectGit(opId = newOpId("detect-git")) {
  return call("detect_git", { opId }, GitDetectionSchema);
}

/** Makes the CLI run `path` (empty: git on PATH) once its `--version` answered. */
export function setGitExecutable(path: string, opId = newOpId("git-executable")) {
  return call("set_git_executable", { path, opId }, GitDetectionSchema);
}

export function closeWalk(walkId: string) {
  return call("close_walk", { walkId }, v.boolean());
}

/** Starts a walk and streams up to `maxPages` pages; continue with `walkContinue`. */
export function walkCommits(
  repo: string,
  scope: WalkScope,
  onPage: (page: WalkPage, seq: number) => void,
  options: WalkOptions = defaultWalkOptions,
  maxPages = 4,
  opId?: string,
): StreamHandle {
  return stream("walk_commits", { repo, scope, options, maxPages }, WalkPageSchema, onPage, opId);
}

/** Streams up to `maxPages` more pages of a walk started by `walkCommits`. */
export function walkContinue(
  walkId: string,
  nextIndex: number,
  onPage: (page: WalkPage, seq: number) => void,
  maxPages = 4,
  opId?: string,
): StreamHandle {
  return stream("walk_continue", { walkId, nextIndex, maxPages }, WalkPageSchema, onPage, opId);
}

/** Computes a diff and streams its files in pages of at most 200. */
export function diff(
  repo: string,
  target: DiffTarget,
  onPage: (page: DiffPage, seq: number) => void,
  options: DiffOptions = defaultDiffOptions,
  opId?: string,
): StreamHandle {
  return stream("diff", { repo, target, options }, DiffPageSchema, onPage, opId);
}

/**
 * The diff of a working-tree target, or of the index against HEAD, restricted to `paths` (each
 * path, what lies below it, and the folder entries and submodules above it) in one reply; null
 * past 200 files, when the full diff streams instead.
 */
export function diffPaths(
  repo: string,
  target: DiffTarget,
  paths: string[],
  options: DiffOptions = defaultDiffOptions,
  opId = newOpId("diff-paths"),
) {
  return call("diff_paths", { repo, target, paths, options, opId }, v.nullable(ChangeSetSchema));
}

/** One file whole at a revision or in the working tree (text, or base64 bytes when binary). */
export function readBlob(repo: string, at: BlobAt, path: string, opId = newOpId("blob")) {
  return call("read_blob", { repo, at, path, opId }, BlobContentSchema);
}

/**
 * The token classes of a file's lines; empty for binary, unknown or oversized files. With
 * `ranges`, only those lines carry tokens (the rest come back empty).
 */
export function highlightFile(
  repo: string,
  at: BlobAt,
  path: string,
  ranges: LineRange[] | null = null,
  opId = newOpId("hl"),
) {
  return call("highlight_file", { repo, at, path, ranges, opId }, HighlightSchema);
}

/** The declarations of a file; empty for a language without a grammar. */
export function fileSymbols(repo: string, at: BlobAt, path: string, opId = newOpId("sym")) {
  return call("file_symbols", { repo, at, path, opId }, v.array(SymbolSchema));
}

/** The marks and notes of a review target. */
export function listAnnotations(repo: string, target: string) {
  return call("list_annotations", { repo, target }, v.array(AnnotationSchema));
}

/** Writes or replaces one mark or note. */
export function setAnnotation(repo: string, target: string, annotation: AnnotationWrite) {
  return call("set_annotation", { repo, target, annotation }, v.null());
}

/** Removes one mark or note; resolves with whether it existed. */
export function deleteAnnotation(repo: string, target: string, annotation: AnnotationWrite) {
  return call("delete_annotation", { repo, target, annotation }, v.boolean());
}

/**
 * Opens `path`, a folder or a file (at `line` when given), with the first template that
 * spawns; resolves with the argv that ran.
 */
export function openExternal(templates: string[], path: string, line: number | null = null) {
  return call("open_external", { templates, path, line }, v.array(v.string()));
}

/** Opens `url`, a forge's page, in the default browser; the backend refuses any other link. */
export function openLink(url: string) {
  return call("open_link", { url }, v.null());
}

/**
 * Reveals `path`, a file or folder of the working tree at `root` or one of its worktrees, in the
 * platform's file manager; the backend refuses a path outside the repositories it knows.
 */
export function revealPath(root: string, path: string) {
  return call("reveal_path", { root, path }, v.null());
}

// --- Discovery ------------------------------------------------------------------------------

/** Folder names the scanner never enters unless the settings say otherwise. */
export const defaultSkipFolders = [
  "node_modules",
  ".cache",
  "target",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".nuxt",
  ".turbo",
  ".yarn",
  ".pnpm-store",
  ".gradle",
  ".idea",
  ".vscode",
];
export const defaultScanOptions: ScanOptions = { skip: defaultSkipFolders, maxDepth: 2 };

/** Starts the filesystem watcher of the open repository; rejects with `watcher.unavailable`. */
export function watchRepository(root: string) {
  return call("watch_repository", { root }, v.null());
}

/**
 * Makes the folder view's watchers follow `roots`: the first 20, but the open
 * repository, get one. Answers the roots they watch once their starts ended.
 */
export function watchFolder(roots: string[]) {
  return call("watch_folder", { roots }, v.array(v.string()));
}

/** Stops the folder view's watchers. */
export function unwatchFolder() {
  return call("unwatch_folder", {}, v.null());
}

export function listRepositories() {
  return call("list_repositories", {}, v.array(IndexEntrySchema));
}

export function recordRepositoryOpen(path: string) {
  return call("record_repository_open", { path }, v.null());
}

/**
 * Describes a repository again; without `dirty`, reads HEAD, the upstream and the tip and keeps
 * the stored dirty flag, with no status of the working tree.
 */
export function refreshRepository(path: string, dirty: boolean, opId = newOpId("refresh")) {
  return call("refresh_repository", { path, dirty, opId }, IndexEntrySchema);
}

/** Every project with its members in order, by name. */
export function listProjects() {
  return call("projects", {}, v.array(ProjectSchema));
}

/** Makes a list project of `paths` in their order. */
export function createProject(name: string, paths: string[]) {
  return call("project_create", { name, paths }, ProjectSchema);
}

/**
 * The folder project of `folder`, found or made and named after the folder; the caller scans
 * it. Rejects with `index.folder` when the folder is not on disk.
 */
export function createFolderProject(folder: string) {
  return call("project_create_folder", { folder }, ProjectSchema);
}

/**
 * The project to open for `path` and the repository to show in it: of the projects holding the
 * repository `path` lies in, the one opened last, or a list project of one made for it. Rejects
 * with `repo.not_found` when `path` lies in no repository.
 */
export function projectForPath(path: string, opId = newOpId("project-for-path")) {
  return call("project_for_path", { path, opId }, ProjectOpenSchema);
}

/** Renames a project; null when it no longer exists. */
export function renameProject(id: number, name: string) {
  return call("project_rename", { id, name }, v.nullable(ProjectSchema));
}

/**
 * Replaces the members a project holds by hand and their order (a folder project keeps its
 * folder's own); answers the project and the paths that left the index, or null when the
 * project no longer exists.
 */
export function setProjectMembers(id: number, paths: string[]) {
  return call("project_set_members", { id, paths }, v.nullable(ProjectEditSchema));
}

/** Pins or unpins a project to the top of Home; whether it exists. */
export function setProjectPinned(id: number, pinned: boolean) {
  return call("project_set_pinned", { id, pinned }, v.boolean());
}

/** Records that a project was opened now showing `repository`; whether it exists. */
export function recordProjectOpen(id: number, repository: string | null) {
  return call("project_record_open", { id, repository }, v.boolean());
}

/**
 * Deletes a project, never a repository's folder; answers the paths that belonged to no other
 * project (they left the index), or null when it no longer existed.
 */
export function deleteProject(id: number) {
  return call("project_delete", { id }, v.nullable(v.array(v.string())));
}

/** Scans `folders` and streams found entries, their summaries, counts and folder states. */
export function scanFolders(
  folders: string[],
  onMessage: (message: ScanMessage, seq: number) => void,
  options: ScanOptions = defaultScanOptions,
  opId?: string,
): StreamHandle {
  return stream("scan_folders", { folders, options }, ScanMessageSchema, onMessage, opId);
}
