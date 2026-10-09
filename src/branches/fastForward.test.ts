import { describe, expect, it } from "vitest";

import type { Ref as GitRef } from "@/ipc/schemas";

import { fastForwardOffer } from "./fastForward";

function branch(overrides: Partial<GitRef> = {}): GitRef {
  return {
    name: "develop",
    fullName: "refs/heads/develop",
    kind: "local-branch",
    target: "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4",
    isCurrent: false,
    upstream: "origin/develop",
    ahead: 0,
    behind: 3,
    worktree: null,
    message: null,
    committedAt: null,
    ...overrides,
  };
}

describe("fastForwardOffer", () => {
  it("offers a branch behind its upstream with nothing of its own", () => {
    expect(fastForwardOffer(branch(), null)).toEqual({ kind: "ready", upstream: "origin/develop" });
  });

  it("says why it cannot move: commits of its own first, then another worktree", () => {
    expect(fastForwardOffer(branch({ ahead: 2 }), "wt-develop")).toEqual({
      kind: "own-commits",
      upstream: "origin/develop",
      commits: 2,
    });
    expect(fastForwardOffer(branch(), "wt-develop")).toEqual({
      kind: "held",
      upstream: "origin/develop",
      folder: "wt-develop",
    });
  });

  it("offers nothing for the current branch, one level or without an upstream, or another kind", () => {
    expect(fastForwardOffer(branch({ isCurrent: true }), null)).toBeNull();
    expect(fastForwardOffer(branch({ behind: 0 }), null)).toBeNull();
    expect(fastForwardOffer(branch({ ahead: null, behind: null }), null)).toBeNull();
    expect(fastForwardOffer(branch({ upstream: null }), null)).toBeNull();
    expect(
      fastForwardOffer(
        branch({ kind: "remote-branch", fullName: "refs/remotes/origin/develop" }),
        null,
      ),
    ).toBeNull();
  });
});
