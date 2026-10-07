import { describe, expect, it } from "vitest";

import type { Ref as GitRef } from "@/ipc/schemas";

import { commitBadges, refsByName, upstreamNames } from "./badges";

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

  it("joins a branch and its upstream on one commit into one badge; apart, each keeps its own", () => {
    const elsewhere = "1".repeat(40);
    const refs = [
      { ...ref("main", "local-branch", true), upstream: "origin/main" },
      { ...ref("claude/fix-auth", "local-branch"), upstream: "origin/claude/fix-auth" },
      ref("origin/main", "remote-branch"),
      ref("origin/claude/fix-auth", "remote-branch", false, elsewhere),
    ];
    const byName = refsByName(refs);
    const names = ["main", "origin/main", "claude/fix-auth"];
    const badges = commitBadges(names, byName, HASH, { join: true });
    expect(badges.map((b) => [b.kind, b.label, b.upstream?.remote])).toEqual([
      ["current", "main", "origin"],
      ["local", "claude/fix-auth", undefined],
    ]);
    // The joined badge's menu is the branch's, with its upstream at hand.
    expect(badges[0]?.ref?.name).toBe("main");
    expect(badges[0]?.upstream?.ref.name).toBe("origin/main");
    const apart = commitBadges(["origin/claude/fix-auth"], byName, elsewhere, { join: true });
    expect(apart[0]?.kind).toBe("remote");
    // Outside the rows (the detail panel, the hover card) each ref keeps its badge.
    expect(commitBadges(names, byName, HASH).map((b) => [b.label, b.upstream])).toEqual([
      ["main", undefined],
      ["origin/main", undefined],
      ["claude/fix-auth", undefined],
    ]);
  });

  it("keeps an upstream of another name apart, so its name shows", () => {
    const refs = [
      { ...ref("feature", "local-branch"), upstream: "origin/main" },
      ref("origin/main", "remote-branch"),
    ];
    const badges = commitBadges(["feature", "origin/main"], refsByName(refs), HASH, {
      join: true,
    });
    expect(badges.map((b) => [b.label, b.upstream])).toEqual([
      ["feature", undefined],
      ["origin/main", undefined],
    ]);
  });

  it("draws a remote branch only as a branch's upstream while the remote branches are hidden", () => {
    const refs = [
      { ...ref("main", "local-branch", false, "2".repeat(40)), upstream: "origin/main" },
      ref("origin/main", "remote-branch"),
      ref("origin/experiment", "remote-branch"),
    ];
    const byName = refsByName(refs);
    const names = ["origin/main", "origin/experiment"];
    const options = { hideRemotes: true, shown: upstreamNames(refs) };
    expect(commitBadges(names, byName, HASH, options).map((b) => b.label)).toEqual(["origin/main"]);
    expect(commitBadges(names, byName, HASH).map((b) => b.label)).toEqual(names);
  });
});
