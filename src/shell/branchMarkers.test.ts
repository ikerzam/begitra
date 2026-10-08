import { describe, expect, it } from "vitest";

import type { Ref as GitRef } from "@/ipc/schemas";

import { goneUpstream, heldIn } from "./branchMarkers";

const ref = (over: Partial<GitRef> = {}): GitRef => ({
  name: "claude/fix-auth",
  fullName: "refs/heads/claude/fix-auth",
  kind: "local-branch",
  target: "a".repeat(40),
  isCurrent: false,
  upstream: null,
  ahead: null,
  behind: null,
  worktree: null,
  message: null,
  committedAt: 1,
  ...over,
});

describe("branch markers", () => {
  it("names the worktree holding a local branch other than the open one", () => {
    expect(heldIn(ref({ worktree: "/code/wt/claude-auth" }))).toBe("claude-auth");
    expect(heldIn(ref({ worktree: "C:\\Code\\wt\\claude-auth" }))).toBe("claude-auth");
    // The open worktree's own branch, and a branch no worktree holds.
    expect(heldIn(ref({ worktree: "/code/geoportal", isCurrent: true }))).toBeNull();
    expect(heldIn(ref())).toBeNull();
    // Only local branches are held.
    expect(heldIn(ref({ kind: "remote-branch", worktree: "/code/wt/x" }))).toBeNull();
  });

  it("names an upstream gone from its remote, the current branch's included", () => {
    expect(goneUpstream(ref({ upstream: "origin/claude/fix-auth" }))).toBe(
      "origin/claude/fix-auth",
    );
    expect(goneUpstream(ref({ upstream: "origin/main", isCurrent: true }))).toBe("origin/main");
    // An upstream with its counts is there; no upstream is not gone.
    expect(goneUpstream(ref({ upstream: "origin/main", ahead: 0, behind: 3 }))).toBeNull();
    expect(goneUpstream(ref())).toBeNull();
    // Remote branches and tags have no upstream of their own.
    expect(goneUpstream(ref({ kind: "remote-branch", upstream: "origin/x" }))).toBeNull();
    expect(goneUpstream(ref({ kind: "tag", upstream: "origin/x" }))).toBeNull();
  });
});
