// What Fetch, Pull and Push would do now in the open repository, or why they cannot: a pure
// function of the checked-out branch, the remotes and what runs, so the top bar's buttons, the
// commit box's Push, their keys and the palette agree. Pull only fast-forwards: a branch with
// commits of its own and commits to bring has diverged and goes to the pull dialog, where a merge
// or a rebase is chosen. Push goes where `pushPlan` says, and has nothing to do on a branch level
// with its upstream. A branch whose upstream is gone from the remote is neither pulled nor pushed
// in one click: pushing it would bring back a branch someone deleted, so that is the dialog's.

import { pushPlan, type PushRefusal } from "@/changes/pushPlan";

export type SyncRefusal =
  | Exclude<PushRefusal, "amendPushed" | "otherRepository">
  /** No repository is open with its refs listed. */
  | "closed"
  /** A fetch, pull or push, or a project's bulk operation, runs. */
  | "busy"
  /** A merge, rebase, cherry-pick or revert stopped in the repository. */
  | "operation"
  /** The branch has no commit yet. */
  | "unborn"
  | "noUpstream"
  /** The upstream was deleted on the remote: its remote-tracking branch is gone. */
  | "upstreamGone"
  /** The branch is level with its upstream: nothing to push. */
  | "level";

export interface SyncInput {
  /** The repository is open and its refs are listed. */
  ready: boolean;
  /** The checked-out branch; null on a detached HEAD. A count is null while not known. */
  branch: {
    name: string;
    upstream: string | null;
    ahead: number | null;
    behind: number | null;
    /** No commit yet: the branch has no ref. */
    unborn: boolean;
    /** The upstream is configured but its remote-tracking branch is gone. */
    gone: boolean;
  } | null;
  /** The names of the repository's remotes; null while they are first read. */
  remotes: readonly string[] | null;
  busy: boolean;
  operation: boolean;
}

export type Refused = { kind: "refused"; reason: SyncRefusal };

export type FetchPlan = { kind: "fetch" } | Refused;

export type PullPlan =
  /** `dialog`: the branch diverged from its upstream, so a merge or a rebase is the user's. */
  { kind: "pull" | "dialog"; branch: string; upstream: string; behind: number } | Refused;

export type SyncPushPlan =
  | { kind: "push"; remote: string; branch: string; publish: boolean; ahead: number }
  /** Several remotes and no upstream: the push dialog opens on the branch. */
  | { kind: "dialog"; branch: string }
  | Refused;

const refused = (reason: SyncRefusal): Refused => ({ kind: "refused", reason });

const noRemote = (input: SyncInput) => input.remotes !== null && input.remotes.length === 0;

export function fetchPlan(input: SyncInput): FetchPlan {
  if (!input.ready) return refused("closed");
  if (input.remotes === null) {
    // An upstream names a remote before the list is read.
    if (!input.branch?.upstream) return refused("readingRemotes");
  } else if (input.remotes.length === 0) {
    return refused("noRemote");
  }
  return input.busy ? refused("busy") : { kind: "fetch" };
}

/** The refusals Pull and Push share, in the order the user is told them. */
function branchRefusal(input: SyncInput): Refused | null {
  if (!input.ready) return refused("closed");
  // During a rebase HEAD is detached: the operation is the reason to give.
  if (input.operation) return refused("operation");
  if (!input.branch) return refused("detached");
  if (noRemote(input)) return refused("noRemote");
  if (input.branch.unborn) return refused("unborn");
  if (input.branch.gone) return refused("upstreamGone");
  return null;
}

export function pullPlan(input: SyncInput): PullPlan {
  const shared = branchRefusal(input);
  if (shared) return shared;
  const branch = input.branch;
  if (!branch?.upstream) return refused("noUpstream");
  if (input.busy) return refused("busy");
  const ahead = branch.ahead ?? 0;
  const behind = branch.behind ?? 0;
  return {
    kind: ahead > 0 && behind > 0 ? "dialog" : "pull",
    branch: branch.name,
    upstream: branch.upstream,
    behind,
  };
}

export function syncPushPlan(input: SyncInput): SyncPushPlan {
  const shared = branchRefusal(input);
  if (shared) return shared;
  const branch = input.branch;
  const plan = pushPlan({
    branch: branch && { name: branch.name, upstream: branch.upstream, ahead: branch.ahead },
    remotes: input.remotes,
    amend: false,
    openRepository: true,
  });
  if (plan.kind === "refused") {
    // `pushPlan` refuses an amend or another repository only when asked about one.
    const { reason } = plan;
    return refused(reason === "amendPushed" || reason === "otherRepository" ? "closed" : reason);
  }
  const ahead = branch?.ahead ?? 0;
  if (plan.kind === "push" && !plan.publish && ahead === 0) return refused("level");
  if (input.busy) return refused("busy");
  return plan.kind === "dialog" ? plan : { ...plan, ahead };
}
