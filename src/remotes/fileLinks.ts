// Where a file's menus link and reveal it. A file of a commit links at that commit; a file of
// the working tree links at the current branch's upstream and shows on disk. A file the place
// lacks gets neither: one its commit deleted, one the upstream has not (new or copied in the
// working tree), one deleted from disk.

import type { FileChange, Ref } from "@/ipc/schemas";
import { joinPath } from "@/shell/joinPath";
import type { ReviewTarget } from "@/stores/review";

import { commitOfRevision } from "./forgeLinks";

/** Where a file is shown: at a commit, or in the working tree at `root`. */
export type FileSource = { kind: "commit"; hash: string } | { kind: "working"; root: string };

/** What the rules read of a file. */
export type FileFacts = Pick<FileChange, "status" | "path" | "oldPath">;

/**
 * Where a review target's files are: a commit's at it, a range's at its end; the working
 * tree's, the index's and a revision's against the working tree in the working tree at `root`.
 * Null without a target or a root, or for a range whose end names no commit the refs know.
 */
export function fileSourceOf(
  target: ReviewTarget | null,
  root: string | null,
  refs: readonly Pick<Ref, "kind" | "name" | "fullName" | "target">[],
): FileSource | null {
  if (target === null || root === null) return null;
  switch (target.kind) {
    case "commit":
      return { kind: "commit", hash: target.hash };
    case "range": {
      const hash = commitOfRevision(target.to, refs);
      return hash === null ? null : { kind: "commit", hash };
    }
    case "worktree":
    case "index":
    case "revisionToWorktree":
      return { kind: "working", root };
  }
}

/** The path a file's link names at `source`; null when the place lacks the file. */
export function linkedPath(file: FileFacts, source: FileSource): string | null {
  if (source.kind === "commit") return file.status === "deleted" ? null : file.path;
  if (file.status === "added" || file.status === "copied") return null;
  return file.status === "renamed" ? (file.oldPath ?? file.path) : file.path;
}

/** The working tree and the absolute path a file is revealed at; null when it is not on disk. */
export function revealTarget(
  file: FileFacts,
  source: FileSource | null,
): { root: string; path: string } | null {
  if (source?.kind !== "working" || file.status === "deleted") return null;
  return { root: source.root, path: joinPath(source.root, file.path) };
}
