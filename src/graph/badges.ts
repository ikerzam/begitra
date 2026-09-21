// Ref badges of a commit row: the walk decorates commits with short ref names, and the ref
// list says what each name is. A branch and a tag can share a name, so names are matched
// against the refs in order and each ref is used once; the key carries the kind.

import type { RefKind as BadgeKind } from "@/components/types";
import type { Ref as GitRef } from "@/ipc/schemas";

export interface Badge {
  key: string;
  kind: BadgeKind;
  label: string;
  /** The ref behind the badge, for its menu; none when the name matched no listed ref. */
  ref?: GitRef;
}

function badgeKind(ref: GitRef): BadgeKind {
  switch (ref.kind) {
    case "local-branch":
      return ref.isCurrent ? "current" : "local";
    case "remote-branch":
      return "remote";
    case "tag":
      return "tag";
    case "stash":
      return "stash";
    default:
      return "head";
  }
}

/** Refs grouped by short name, in the order the ref list gives them. */
export function refsByName(refs: GitRef[]): Map<string, GitRef[]> {
  const map = new Map<string, GitRef[]>();
  for (const ref of refs) {
    const list = map.get(ref.name);
    if (list) list.push(ref);
    else map.set(ref.name, [ref]);
  }
  return map;
}

/**
 * The badges of a commit decorated with `names`. Each name takes the first ref of that name
 * not used by an earlier name of the same commit, so `["v1", "v1"]` with a branch and a tag
 * `v1` yields one badge of each kind; a name without a ref is shown as a local branch.
 */
export function commitBadges(names: string[], byName: Map<string, GitRef[]>): Badge[] {
  const used = new Map<string, number>();
  const badges: Badge[] = [];
  for (const name of names) {
    if (name === "HEAD") continue;
    const candidates = byName.get(name) ?? [];
    const index = used.get(name) ?? 0;
    used.set(name, index + 1);
    const ref = candidates[index];
    const kind = ref ? badgeKind(ref) : "local";
    badges.push(
      ref
        ? { key: `${kind}:${name}`, kind, label: name, ref }
        : { key: `${kind}:${name}`, kind, label: name },
    );
  }
  return badges;
}
