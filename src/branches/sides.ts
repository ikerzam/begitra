// The two sides of the operation in progress as the interface names them: a ref by its short
// name, a commit by its short hash, a revert's theirs as the state before its commit; and
// whether a side has a conflicted file at all, by the conflict's kind (git's stage 2 for ours,
// 3 for theirs).

import type { ConflictKind, Side, SideName } from "@/ipc/schemas";
import { shortHash } from "@/shell/format";

/** The params a side's sentences take: a ref's name, a commit's short hash. */
export function sideParams(side: SideName): { name: string; hash: string } {
  return side.kind === "ref"
    ? { name: side.name, hash: "" }
    : { name: "", hash: shortHash(side.hash) };
}

/** Whether `side` has the file of a conflict of `kind`; taking a side without it deletes it. */
export function sideHasFile(kind: ConflictKind, side: Side): boolean {
  switch (kind) {
    case "both-modified":
    case "both-added":
      return true;
    case "both-deleted":
      return false;
    case "deleted-by-us":
    case "added-by-them":
      return side === "theirs";
    case "deleted-by-them":
    case "added-by-us":
      return side === "ours";
  }
}

/** The side the other one is. */
export function otherSide(side: Side): Side {
  return side === "ours" ? "theirs" : "ours";
}
