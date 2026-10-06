// Whether HEAD's commit can be undone by moving HEAD back to its parent, as a soft reset does,
// and whether that needs asking first. Refused on an unborn branch; on a commit with no parent
// here (a repository's first commit, or where a shallow clone's history stops); on a merge
// commit, whose undo would stage the merged branch's changes as one; while an operation holds
// HEAD (a merge, a rebase, a cherry-pick or a revert, a paused sequence of them, a bisect, a
// stopped `git am`) or the index holds conflicts, where git's soft reset refuses a merge and
// unmerged entries only; and while the refs shown name another
// commit than the one read (HEAD is moving). A commit a remote's tracking branch holds is
// undone only after a confirmation, since it stays there and the next push needs a forced push.

import { remoteOf } from "@/branches/names";
import type { CommitContext } from "@/ipc/schemas";
import { splitUpstream } from "@/stores/remotes";

export type UndoRefusal =
  | "unborn"
  | "root"
  | "merge"
  | "merging"
  | "rebasing"
  | "cherry-picking"
  | "reverting"
  | "bisect"
  | "am"
  | "sequence"
  | "conflicts"
  | "moving"
  | "unknown";

export type UndoPlan =
  /** `parent`: where HEAD goes. `pushed`: `remote`'s tracking branch holds the commit. */
  | { kind: "undo"; hash: string; parent: string; pushed: boolean; remote: string | null }
  | { kind: "refused"; reason: UndoRefusal };

export interface UndoPlanInput {
  /** The commit box's context, read for the plan; null when it could not be read. */
  context: Pick<
    CommitContext,
    "head" | "headParents" | "unborn" | "operation" | "otherOperation"
  > | null;
  /** HEAD's commit as the refs listing shows it. */
  shownHead: string | null;
  /** The index holds conflicts. */
  conflicts: boolean;
  /** The checked-out branch; null on a detached HEAD. `ahead` is null when it is not known. */
  branch: { upstream: string | null; ahead: number | null } | null;
  /** The repository's remotes; null when they could not be read. */
  remotes: readonly { name: string }[] | null;
}

const OPERATIONS = {
  merge: "merging",
  rebase: "rebasing",
  "cherry-pick": "cherry-picking",
  revert: "reverting",
} as const;

const refused = (reason: UndoRefusal): UndoPlan => ({ kind: "refused", reason });

/** What holds HEAD where it is (an operation in progress, conflicts), as a refusal; null for nothing. */
export function heldBy(
  context: Pick<CommitContext, "operation" | "otherOperation">,
  conflicts: boolean,
): UndoRefusal | null {
  if (context.operation !== "none") return OPERATIONS[context.operation];
  if (context.otherOperation !== null) return context.otherOperation;
  return conflicts ? "conflicts" : null;
}

export function undoPlan(input: UndoPlanInput): UndoPlan {
  const context = input.context;
  if (!context) return refused("unknown");
  if (context.unborn || context.head === null) return refused("unborn");
  const held = heldBy(context, input.conflicts);
  if (held !== null) return refused(held);
  const [parent, ...others] = context.headParents;
  if (parent === undefined) return refused("root");
  if (others.length > 0) return refused("merge");
  // The upstream's count is the shown HEAD's: it says nothing of another commit.
  if (input.shownHead !== context.head) return refused("moving");
  return { kind: "undo", hash: context.head, parent, ...pushedTo(input) };
}

/** Nothing ahead of the upstream: the commit is on it, when the upstream is a remote's. */
function pushedTo(input: UndoPlanInput): { pushed: boolean; remote: string | null } {
  const upstream = input.branch?.ahead === 0 ? input.branch.upstream : null;
  if (upstream === null) return { pushed: false, remote: null };
  // Without the remotes, the name's first part stands for one: asking is the safe side.
  const remote =
    input.remotes === null
      ? (splitUpstream(upstream)?.remote ?? null)
      : (remoteOf({ kind: "remote-branch", name: upstream }, input.remotes)?.remote ?? null);
  return { pushed: remote !== null, remote };
}
