// The badges of "Contained in": the refs whose history holds the selected commit, drawn as the
// graph draws refs. The engine answers full names; the listing says what each one is. The order
// answers a review's questions first: is it in main, did it reach the remote, which release
// shipped it.

import type { RefKind as BadgeKind } from "@/components/types";
import { badgeKind } from "@/graph/badges";
import type { Ref as GitRef } from "@/ipc/schemas";

export interface ContainedBadge {
  key: string;
  kind: BadgeKind;
  label: string;
}

/** Where a ref sorts: its group, then its place in the group. */
type Place = [group: number, place: number, index: number];

/**
 * The badges of the refs named by `fullNames`: the `leading` local branches (the current one and
 * the main worktree's, in that order), then their upstreams; the tags, oldest commit first, so
 * the first release that shipped the commit leads them; then the other local branches and the
 * other remote branches, each in the listing's order. A name the listing has not (a remote's
 * symbolic `HEAD`, a ref deleted since) is left out.
 */
export function containedBadges(
  fullNames: readonly string[],
  refs: readonly GitRef[],
  leading: readonly string[] = [],
): ContainedBadge[] {
  const listed = new Map(refs.map((ref, index) => [ref.fullName, { ref, index }]));
  const lead = new Map<string, number>();
  for (const name of leading) if (!lead.has(name)) lead.set(name, lead.size);
  const upstreams = new Map<string, number>();
  for (const ref of refs) {
    const position = lead.get(ref.name);
    if (ref.kind === "local-branch" && position !== undefined && ref.upstream) {
      upstreams.set(ref.upstream, position);
    }
  }
  const placeOf = (ref: GitRef, index: number): Place | null => {
    switch (ref.kind) {
      case "local-branch": {
        const position = lead.get(ref.name);
        return position === undefined ? [3, 0, index] : [0, position, index];
      }
      case "remote-branch": {
        const position = upstreams.get(ref.name);
        return position === undefined ? [4, 0, index] : [1, position, index];
      }
      case "tag":
        return [2, ref.committedAt ?? Number.POSITIVE_INFINITY, index];
      default:
        return null;
    }
  };
  return fullNames
    .flatMap((name) => {
      const entry = listed.get(name);
      const place = entry ? placeOf(entry.ref, entry.index) : null;
      return entry && place ? [{ ref: entry.ref, place }] : [];
    })
    .sort((a, b) => a.place[0] - b.place[0] || a.place[1] - b.place[1] || a.place[2] - b.place[2])
    .map(({ ref }) => ({ key: ref.fullName, kind: badgeKind(ref), label: ref.name }));
}
