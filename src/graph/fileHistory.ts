// The path a file's "File history" lists in the graph: the path the commits behind the file
// name it under. A committed change lists its own path, which its commits touch (a rename's new
// one). The index's change against HEAD lists a rename's or a copy's old path, and none for a
// file it adds. The working tree's change is against the index, so the path it has there goes
// through the index's own change: an edit after `git mv` lists the name before the move.

import type { FileChange } from "@/ipc/schemas";
import type { ReviewTarget } from "@/stores/review";

/** Where a file's change stands: commits, the index against HEAD, or the working tree against the index. */
export type HistorySide = "committed" | "index" | "worktree";

type Named = Pick<FileChange, "status" | "path" | "oldPath">;

/**
 * The side of a review target. A revision against the working tree counts as committed: a file
 * added since the revision may have commits after it, so its own path is listed, as a range's.
 */
export function historySide(target: ReviewTarget | null): HistorySide {
  if (target?.kind === "index") return "index";
  if (target?.kind === "worktree") return "worktree";
  return "committed";
}

/**
 * The path whose history the graph lists for `file`, or null when it has none; `staged` gives
 * the Staged list's file at a path, for a working tree's change.
 */
export function historyPath(
  file: Named,
  side: HistorySide,
  staged?: (path: string) => Named | undefined,
): string | null {
  if (side === "committed") return file.path;
  const behind = pathBehind(file);
  if (behind === null || side === "index") return behind;
  const entry = staged?.(behind);
  return entry ? pathBehind(entry) : behind;
}

/** The path a change's file has on the side it is compared with; none for a file it adds. */
function pathBehind(file: Named): string | null {
  if (file.status === "added") return null;
  const moved = file.status === "renamed" || file.status === "copied";
  return moved && file.oldPath !== null ? file.oldPath : file.path;
}
