// Ref badges of a commit row: the walk decorates commits with short ref names, and the ref
// list says what each name is and where it points now. A branch and a tag can share a name, so
// names are matched against the refs in order and each ref is used once; the key carries the
// kind. A name whose ref points elsewhere since the walk (moved, deleted, another stash) draws
// nothing until the history lists again, so no badge offers a ref it does not stand for.

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
 * The badges of the commit `hash` decorated with `names`. Each name takes the first ref of
 * that name that points at the commit and is not used by an earlier name of the same commit,
 * so `["v1", "v1"]` with a branch and a tag `v1` yields one badge of each kind. Once refs are
 * listed, a name with no such ref draws nothing; before, it is shown as a local branch.
 */
export function commitBadges(
  names: string[],
  byName: Map<string, GitRef[]>,
  hash: string,
): Badge[] {
  const listed = byName.size > 0;
  const used = new Map<string, number>();
  const badges: Badge[] = [];
  for (const name of names) {
    if (name === "HEAD") continue;
    const candidates = (byName.get(name) ?? []).filter((entry) => entry.target === hash);
    const index = used.get(name) ?? 0;
    used.set(name, index + 1);
    const ref = candidates[index];
    if (!ref && listed) continue;
    const kind = ref ? badgeKind(ref) : "local";
    badges.push(
      ref
        ? { key: `${kind}:${name}`, kind, label: name, ref }
        : { key: `${kind}:${name}`, kind, label: name },
    );
  }
  return badges;
}
