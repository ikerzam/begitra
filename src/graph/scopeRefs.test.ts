import { describe, expect, it } from "vitest";

import type { Ref as GitRef } from "@/ipc/schemas";

import { globToRegExp, patternNames } from "./scopeRefs";

function ref(kind: GitRef["kind"], name: string, fullName: string): GitRef {
  return {
    name,
    fullName,
    kind,
    target: "0".repeat(40),
    isCurrent: false,
    upstream: null,
    ahead: null,
    behind: null,
    worktree: null,
    message: null,
    committedAt: 0,
  };
}

const matches = (pattern: string, name: string) => globToRegExp(pattern).test(name);

describe("globToRegExp", () => {
  it("matches * within a segment and ** across segments", () => {
    expect(matches("claude/*", "claude/fix-auth")).toBe(true);
    expect(matches("claude/*", "claude/a/b")).toBe(false);
    expect(matches("claude/*", "codex/fix")).toBe(false);
    expect(matches("claude/**", "claude/a/b")).toBe(true);
    expect(matches("**/fix-*", "fix-auth")).toBe(true);
    expect(matches("**/fix-*", "claude/fix-auth")).toBe(true);
    expect(matches("*", "main")).toBe(true);
    expect(matches("*", "claude/x")).toBe(false);
  });

  it("takes ? as one character and everything else literally, case and all", () => {
    expect(matches("release/2.?", "release/2.4")).toBe(true);
    expect(matches("release/2.*", "release/2x4")).toBe(false);
    expect(matches("feat+(x)", "feat+(x)")).toBe(true);
    expect(matches("Claude/*", "claude/x")).toBe(false);
  });
});

describe("patternNames", () => {
  const refs = [
    ref("local-branch", "main", "refs/heads/main"),
    ref("local-branch", "claude/fix-auth", "refs/heads/claude/fix-auth"),
    ref("remote-branch", "origin/claude/fix-auth", "refs/remotes/origin/claude/fix-auth"),
    ref("remote-branch", "origin/claude/tiles", "refs/remotes/origin/claude/tiles"),
    ref("remote-branch", "my/fork/claude/x", "refs/remotes/my/fork/claude/x"),
    ref("tag", "claude/v1", "refs/tags/claude/v1"),
  ];

  it("names the local branches it matches and the remote ones by their name on the remote", () => {
    expect(patternNames("claude/*", refs, [{ name: "origin" }, { name: "my/fork" }])).toEqual([
      "refs/heads/claude/fix-auth",
      "refs/remotes/origin/claude/fix-auth",
      "refs/remotes/origin/claude/tiles",
      "refs/remotes/my/fork/claude/x",
    ]);
  });

  it("takes the first segment as the remote while the remotes are not listed", () => {
    expect(patternNames("claude/*", refs, [])).toEqual([
      "refs/heads/claude/fix-auth",
      "refs/remotes/origin/claude/fix-auth",
      "refs/remotes/origin/claude/tiles",
    ]);
  });

  it("matches no tag, and nothing for an empty pattern", () => {
    expect(patternNames("claude/v1", refs, [])).toEqual([]);
    expect(patternNames("  ", refs, [])).toEqual([]);
  });
});
