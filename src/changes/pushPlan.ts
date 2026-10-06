// What a commit and push would do with the branch as it stands: push it to its upstream, publish
// it to the repository's only remote, leave the remote to the push dialog, or nothing, for a
// reason the box shows before anything is committed. A fetch, pull or push that runs meanwhile
// is no reason: the push waits for it (`pushWhenFree`).

import { splitUpstream } from "@/stores/remotes";

export type PushRefusal =
  | "detached"
  | "noRemote"
  | "readingRemotes"
  | "renamedUpstream"
  | "amendPushed"
  | "otherRepository";

export type PushPlan =
  /** `publish` sets the upstream (`--set-upstream`), the branch having none. */
  | { kind: "push"; remote: string; branch: string; publish: boolean }
  /** Several remotes and no upstream: the push dialog opens on the branch after the commit. */
  | { kind: "dialog"; branch: string }
  | { kind: "refused"; reason: PushRefusal };

export interface PushPlanInput {
  /** The checked-out branch; null on a detached HEAD. `ahead` is null when it is not known. */
  branch: { name: string; upstream: string | null; ahead: number | null } | null;
  /** The names of the repository's remotes; null while they are being read. */
  remotes: readonly string[] | null;
  /** The commit amends HEAD. */
  amend: boolean;
  /** The box commits the open repository, the one the push commands act on. */
  openRepository: boolean;
}

const refused = (reason: PushRefusal): PushPlan => ({ kind: "refused", reason });

export function pushPlan(input: PushPlanInput): PushPlan {
  if (!input.openRepository) return refused("otherRepository");
  const branch = input.branch;
  if (!branch) return refused("detached");
  const upstream = splitUpstream(branch.upstream);
  if (upstream) {
    // The push names the local branch only, so it would land beside an upstream of another name.
    if (upstream.branch !== branch.name) return refused("renamedUpstream");
    // Nothing ahead: the commit an amend replaces is on the upstream, and only a force moves it.
    if (input.amend && branch.ahead === 0) return refused("amendPushed");
    return { kind: "push", remote: upstream.remote, branch: branch.name, publish: false };
  }
  if (input.remotes === null) return refused("readingRemotes");
  const [only, ...others] = input.remotes;
  if (only === undefined) return refused("noRemote");
  if (others.length > 0) return { kind: "dialog", branch: branch.name };
  return { kind: "push", remote: only, branch: branch.name, publish: true };
}
