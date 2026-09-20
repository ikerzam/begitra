// Typed client of every Tauri command. Non-streaming commands return validated results;
// paged ones return a `StreamHandle` (see `stream.ts`). Every function takes an optional
// `opId` so callers can cancel through `cancelOperation`.

import * as v from "valibot";

import { call, newOpId } from "./invoke";
import {
  CommitCountSchema,
  DiffPageSchema,
  IndexEntrySchema,
  PongSchema,
  RefSchema,
  RepoSchema,
  ScanMessageSchema,
  StatusEntrySchema,
  WalkPageSchema,
  WorktreeSchema,
  type DiffOptions,
  type DiffPage,
  type DiffTarget,
  type RepoChanged,
  type ScanMessage,
  type ScanOptions,
  type StatusOptions,
  type WalkOptions,
  type WalkPage,
  type WalkScope,
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
};

export function ping(message: string) {
  return call("ping", { message }, PongSchema);
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

/** How many commits a scope holds (capped at 100,000 with `capped` set). */
export function countCommits(repo: string, scope: WalkScope, opId = newOpId("count")) {
  return call("count_commits", { repo, scope, opId }, CommitCountSchema);
}

export function listWorktrees(repo: string, opId = newOpId("worktrees")) {
  return call("list_worktrees", { repo, opId }, v.array(WorktreeSchema));
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

/** Opens `path` with the first template that spawns; resolves with the argv that ran. */
export function openExternal(templates: string[], path: string) {
  return call("open_external", { templates, path }, v.array(v.string()));
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
export const defaultScanOptions: ScanOptions = { skip: defaultSkipFolders, maxDepth: 6 };

/** Starts the filesystem watcher of the open repository; rejects with `watcher.unavailable`. */
export function watchRepository(root: string) {
  return call("watch_repository", { root }, v.null());
}

export function listRepositories() {
  return call("list_repositories", {}, v.array(IndexEntrySchema));
}

export function pinRepository(path: string, pinned: boolean) {
  return call("pin_repository", { path, pinned }, v.null());
}

export function forgetRepository(path: string) {
  return call("forget_repository", { path }, v.null());
}

export function recordRepositoryOpen(path: string) {
  return call("record_repository_open", { path }, v.null());
}

export function refreshRepository(path: string, opId = newOpId("refresh")) {
  return call("refresh_repository", { path, opId }, IndexEntrySchema);
}

export function removeScanRoot(root: string) {
  return call("remove_scan_root", { root }, v.null());
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
