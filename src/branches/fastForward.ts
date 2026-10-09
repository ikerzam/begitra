// Whether a local branch's menu offers "Fast-forward to <upstream>", and why the item cannot run
// when it shows disabled. A branch that is not the current one and is behind its upstream moves
// without a checkout only when it has no commits of its own and no other worktree holds it; the
// current branch has Pull, and a branch level with its upstream, or without one, has nothing to
// bring.

import type { Ref as GitRef } from "@/ipc/schemas";

export type FastForwardOffer =
  | { kind: "ready"; upstream: string }
  | { kind: "own-commits"; upstream: string; commits: number }
  | { kind: "held"; upstream: string; folder: string };

/** The offer for `ref`; `heldFolder` names the other worktree that holds it, if one does. */
export function fastForwardOffer(ref: GitRef, heldFolder: string | null): FastForwardOffer | null {
  if (ref.kind !== "local-branch" || ref.isCurrent || !ref.upstream || !ref.behind) return null;
  if (ref.ahead) return { kind: "own-commits", upstream: ref.upstream, commits: ref.ahead };
  if (heldFolder !== null) return { kind: "held", upstream: ref.upstream, folder: heldFolder };
  return { kind: "ready", upstream: ref.upstream };
}
