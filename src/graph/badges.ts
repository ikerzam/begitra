// Ref badges of a commit row: the walk decorates commits with short ref names, and the ref
// list says what each name is and where it points now. A branch and a tag can share a name, so
// names are matched against the refs in order and each ref is used once; the key carries the
// kind. A name whose ref points elsewhere since the walk (moved, deleted, another stash) draws
// nothing until the history lists again, so no badge offers a ref it does not stand for. In the
// graph's rows a local branch and its upstream of the same name on the same commit draw one
// badge, the remote's name after the branch's; while the remote branches are hidden, a remote
// branch draws only as an upstream or as a branch the scope names. The detail panel and the
// hover card list each ref.

import type { RefKind as BadgeKind } from "@/components/types";
import type { Ref as GitRef } from "@/ipc/schemas";

export interface Badge {
  key: string;
  kind: BadgeKind;
  label: string;
  /** The ref behind the badge, for its menu; none when the name matched no listed ref. */
  ref?: GitRef;
  /** A local branch's upstream on the same commit, joined to its badge. */
  upstream?: { remote: string; ref: GitRef };
}

export interface BadgeOptions {
  /** A branch and its upstream on the commit draw one badge (the graph's rows). */
  join?: boolean;
  /** The remote branches are hidden: only those of `shown` draw. */
  hideRemotes?: boolean;
  /**
   * The remote branches (short names) that draw while hidden: the local branches' upstreams
   * (`upstreamNames`) and those the scope names.
   */
  shown?: ReadonlySet<string>;
}

/** The short names of the local branches' upstreams (`origin/main`). */
export function upstreamNames(refs: readonly GitRef[]): Set<string> {
  const names = new Set<string>();
  for (const ref of refs) {
    if (ref.kind === "local-branch" && ref.upstream) names.add(ref.upstream);
  }
  return names;
}

/**
 * The remote of an upstream that has the branch's own name (`origin` for `main` tracking
 * `origin/main`); null for one named otherwise, which keeps a badge of its own so its name shows.
 */
function remoteName(upstream: string, branch: string): string | null {
  if (!upstream.endsWith(`/${branch}`)) return null;
  return upstream.slice(0, upstream.length - branch.length - 1);
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
  options: BadgeOptions = {},
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
  return joinUpstreams(badges, options);
}

/** Joins each local branch with its upstream on the same commit, and hides the other remotes. */
function joinUpstreams(badges: Badge[], options: BadgeOptions): Badge[] {
  if (!options.join && !options.hideRemotes) return badges;
  const remotes = new Map<string, Badge>();
  for (const badge of badges) if (badge.kind === "remote") remotes.set(badge.label, badge);
  const joined = new Set<string>();
  const result: Badge[] = [];
  for (const badge of badges) {
    const upstream = badge.ref?.kind === "local-branch" ? badge.ref.upstream : null;
    const partner = options.join && upstream ? remotes.get(upstream) : undefined;
    const remote = upstream ? remoteName(upstream, badge.label) : null;
    if (partner?.ref && remote !== null && !joined.has(partner.key)) {
      joined.add(partner.key);
      result.push({ ...badge, upstream: { remote, ref: partner.ref } });
    } else {
      result.push(badge);
    }
  }
  return result.filter((badge) => {
    if (badge.kind !== "remote") return true;
    if (joined.has(badge.key)) return false;
    return !options.hideRemotes || (options.shown?.has(badge.label) ?? false);
  });
}
