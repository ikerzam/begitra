import { describe, expect, it } from "vitest";

import type { Ref as GitRef } from "@/ipc/schemas";

import { commitBadges, refsByName } from "./badges";

const HASH = "0".repeat(40);

function ref(name: string, kind: GitRef["kind"], isCurrent = false, target = HASH): GitRef {
  return {
    name,
    fullName: `refs/${kind}/${name}`,
    kind,
    target,
    isCurrent,
    upstream: null,
    ahead: null,
    behind: null,
    worktree: null,
    message: null,
    committedAt: null,
  };
}

describe("commitBadges", () => {
  it("gives a branch and a tag of the same name one badge each, with distinct keys", () => {
    const byName = refsByName([ref("v1", "local-branch"), ref("v1", "tag")]);
    const badges = commitBadges(["HEAD", "v1", "v1"], byName, HASH);
    expect(badges.map((b) => b.kind)).toEqual(["local", "tag"]);
    expect(new Set(badges.map((b) => b.key)).size).toBe(2);
  });

  it("marks the current branch, remotes and stashes", () => {
    const byName = refsByName([
      ref("main", "local-branch", true),
      ref("origin/main", "remote-branch"),
      ref("stash@{0}", "stash"),
    ]);
    const badges = commitBadges(["main", "origin/main", "stash@{0}"], byName, HASH);
    expect(badges.map((b) => b.kind)).toEqual(["current", "remote", "stash"]);
    // The ref behind a badge is what its menu acts on.
    expect(badges[0]?.ref?.fullName).toBe("refs/local-branch/main");
  });

  it("draws a name as a local branch until the refs are listed", () => {
    const badges = commitBadges(["main", "mystery"], new Map(), HASH);
    expect(badges.map((b) => [b.kind, b.label])).toEqual([
      ["local", "main"],
      ["local", "mystery"],
    ]);
    expect(badges[0]?.ref).toBeUndefined();
  });

  it("drops a name whose ref points elsewhere since the walk: moved, deleted, another stash", () => {
    const elsewhere = "1".repeat(40);
    const byName = refsByName([
      ref("main", "local-branch", true),
      ref("origin/main", "remote-branch", false, elsewhere),
      ref("stash@{0}", "stash", false, elsewhere),
    ]);
    const badges = commitBadges(["main", "origin/main", "gone", "stash@{0}"], byName, HASH);
    expect(badges.map((b) => b.label)).toEqual(["main"]);
    // On the commit it points at now, the moved ref is drawn with its kind.
    expect(commitBadges(["origin/main"], byName, elsewhere).map((b) => b.kind)).toEqual(["remote"]);
  });
});
