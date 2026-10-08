import { describe, expect, it } from "vitest";

import type { Ref as GitRef } from "@/ipc/schemas";

import { containedBadges } from "./contained";

function ref(name: string, kind: GitRef["kind"], extra: Partial<GitRef> = {}): GitRef {
  const prefix = {
    "local-branch": "refs/heads/",
    "remote-branch": "refs/remotes/",
    tag: "refs/tags/",
  };
  return {
    name,
    fullName: `${prefix[kind as keyof typeof prefix] ?? ""}${name}`,
    kind,
    target: "1".repeat(40),
    isCurrent: false,
    upstream: null,
    ahead: null,
    behind: null,
    worktree: null,
    message: null,
    committedAt: null,
    ...extra,
  };
}

const refs: GitRef[] = [
  ref("claude/fix-auth", "local-branch", { upstream: "origin/claude/fix-auth" }),
  ref("develop", "local-branch", { upstream: "origin/develop" }),
  ref("main", "local-branch", { upstream: "origin/main" }),
  ref("origin/claude/fix-auth", "remote-branch"),
  ref("origin/develop", "remote-branch"),
  ref("origin/main", "remote-branch"),
  ref("v2.4.0", "tag", { committedAt: 3_000 }),
  ref("v2.3.1", "tag", { committedAt: 2_000 }),
  ref("nightly", "tag", { committedAt: null }),
];
const all = refs.map((entry) => entry.fullName).reverse();

describe("containedBadges", () => {
  it("leads with the current and main branches and their upstreams, then the tags oldest first", () => {
    const current = refs.map((entry) =>
      entry.name === "develop" ? { ...entry, isCurrent: true } : entry,
    );
    expect(
      containedBadges(all, current, ["develop", "main"]).map((badge) => [badge.kind, badge.label]),
    ).toEqual([
      ["current", "develop"],
      ["local", "main"],
      ["remote", "origin/develop"],
      ["remote", "origin/main"],
      ["tag", "v2.3.1"],
      ["tag", "v2.4.0"],
      ["tag", "nightly"],
      ["local", "claude/fix-auth"],
      ["remote", "origin/claude/fix-auth"],
    ]);
  });

  it("keeps the listing's order without leading branches", () => {
    expect(containedBadges(all, refs).map((badge) => badge.label)).toEqual([
      "v2.3.1",
      "v2.4.0",
      "nightly",
      "claude/fix-auth",
      "develop",
      "main",
      "origin/claude/fix-auth",
      "origin/develop",
      "origin/main",
    ]);
  });

  it("leaves out a name the listing has not, and keeps each key apart", () => {
    const badges = containedBadges(
      ["refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/gone"],
      refs,
      ["main", "main"],
    );
    expect(badges.map((badge) => badge.label)).toEqual(["main"]);
    const both = containedBadges(
      ["refs/heads/v2.4.0", "refs/tags/v2.4.0"],
      [...refs, ref("v2.4.0", "local-branch")],
    );
    expect(new Set(both.map((badge) => badge.key)).size).toBe(2);
    expect(containedBadges([], refs)).toEqual([]);
  });
});
