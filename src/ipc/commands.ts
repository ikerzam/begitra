// Typed client of every Tauri command. Non-streaming commands return validated results;
// paged ones return a `StreamHandle` (see `stream.ts`). Every function takes an optional
// `opId` so callers can cancel through `cancelOperation`.

import * as v from "valibot";

import { call, newOpId } from "./invoke";
import {
  DiffPageSchema,
  PongSchema,
  RefSchema,
  RepoSchema,
  StatusEntrySchema,
  WalkPageSchema,
  WorktreeSchema,
  type DiffOptions,
  type DiffPage,
  type DiffTarget,
  type RepoChanged,
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
