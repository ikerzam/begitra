// Lane colours of the branches: by position among the refs of the same kind, since a branch
// row carries no graph lane. The sidebar and the status bar read
// the same map, so the current branch keeps one colour everywhere.

import { laneIndex } from "@/components/lanes";
import type { Ref as GitRef } from "@/ipc/schemas";

/** Lane of every local and remote branch, keyed by full ref name; tags and stashes get none. */
export function branchLanes(refs: GitRef[]): Map<string, number> {
  const lanes = new Map<string, number>();
  const positions: Partial<Record<GitRef["kind"], number>> = {};
  for (const ref of refs) {
    if (ref.kind !== "local-branch" && ref.kind !== "remote-branch") continue;
    const position = positions[ref.kind] ?? 0;
    positions[ref.kind] = position + 1;
    lanes.set(ref.fullName, laneIndex(position + 1));
  }
  return lanes;
}
