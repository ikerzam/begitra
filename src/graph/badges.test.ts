import { describe, expect, it } from "vitest";

import type { Ref as GitRef } from "@/ipc/schemas";

import { commitBadges, refsByName } from "./badges";

function ref(name: string, kind: GitRef["kind"], isCurrent = false): GitRef {
  return {
    name,
    fullName: `refs/${kind}/${name}`,
    kind,
    target: "0".repeat(40),
    isCurrent,
    upstream: null,
    ahead: null,
    behind: null,
    worktree: null,
    message: null,
  };
}

describe("commitBadges", () => {
  it("gives a branch and a tag of the same name one badge each, with distinct keys", () => {
    const byName = refsByName([ref("v1", "local-branch"), ref("v1", "tag")]);
    const badges = commitBadges(["HEAD", "v1", "v1"], byName);
    expect(badges.map((b) => b.kind)).toEqual(["local", "tag"]);
    expect(new Set(badges.map((b) => b.key)).size).toBe(2);
  });

  it("marks the current branch, remotes and stashes, and falls back to local", () => {
    const byName = refsByName([
      ref("main", "local-branch", true),
      ref("origin/main", "remote-branch"),
      ref("stash@{0}", "stash"),
    ]);
    const badges = commitBadges(["main", "origin/main", "stash@{0}", "mystery"], byName);
    expect(badges.map((b) => b.kind)).toEqual(["current", "remote", "stash", "local"]);
    expect(badges[3]?.label).toBe("mystery");
    // The ref behind a badge is what its menu acts on; a name without a ref has none.
    expect(badges[0]?.ref?.fullName).toBe("refs/local-branch/main");
    expect(badges[3]?.ref).toBeUndefined();
  });
});
