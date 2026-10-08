// What a branch row says beyond its name: the worktree that holds a local branch when it is not
// the one open, and an upstream gone from its remote. Pure, so the sidebar computes them once per
// row.

import type { Ref as GitRef } from "@/ipc/schemas";

import { baseName } from "./format";

/** The folder of the worktree that holds a local branch, when that worktree is not the open one. */
export function heldIn(ref: GitRef): string | null {
  if (ref.kind !== "local-branch" || ref.worktree === null || ref.isCurrent) return null;
  return baseName(ref.worktree);
}

/**
 * The upstream of a local branch that is gone from its remote: named, with no counts, which the
 * refs listing gives only when the upstream's ref is missing, as `git branch -vv` marks it gone.
 */
export function goneUpstream(ref: GitRef): string | null {
  if (ref.kind !== "local-branch" || ref.upstream === null) return null;
  return ref.ahead === null && ref.behind === null ? ref.upstream : null;
}
