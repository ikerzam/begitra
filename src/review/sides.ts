// Where the two sides of a file live for a review target: what `read_blob`, `highlight_file`
// and `file_symbols` are asked for. A side the engine cannot address (the index, the merge
// base of a three-dot range) is null and the viewer does without it.

import type { BlobAt, FileChange } from "@/ipc/schemas";
import type { ReviewTarget } from "@/stores/review";

export interface FileSides {
  old: { at: BlobAt; path: string } | null;
  new: { at: BlobAt; path: string } | null;
}

export function fileSides(target: ReviewTarget, file: FileChange): FileSides {
  const oldPath = file.oldPath ?? file.path;
  const revision = (rev: string): BlobAt => ({ kind: "revision", rev });
  const worktree: BlobAt = { kind: "working-tree" };
  let old: BlobAt | null = null;
  let current: BlobAt | null = null;
  switch (target.kind) {
    case "commit":
      old = revision(`${target.hash}^`);
      current = revision(target.hash);
      break;
    case "range":
      old = target.threeDot ? null : revision(target.from);
      current = revision(target.to);
      break;
    case "worktree":
      current = worktree;
      break;
    case "index":
      old = revision("HEAD");
      break;
    case "revisionToWorktree":
      old = revision(target.revision);
      current = worktree;
      break;
  }
  if (file.status === "added") old = null;
  if (file.status === "deleted") current = null;
  return {
    old: old ? { at: old, path: oldPath } : null,
    new: current ? { at: current, path: file.path } : null,
  };
}

/** Image formats the viewer shows as pictures, by extension. */
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

/** The media type of an image path, or null for other files. */
export function imageType(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return IMAGE_TYPES[path.slice(dot + 1).toLowerCase()] ?? null;
}
