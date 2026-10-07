import { describe, expect, it } from "vitest";

import { fetchPlan, pullPlan, syncPushPlan, type SyncInput } from "./syncPlan";

const base: SyncInput = {
  ready: true,
  branch: {
    name: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    unborn: false,
    gone: false,
  },
  remotes: ["origin"],
  busy: false,
  operation: false,
};

/** `base` with `over`, and its branch with `branch` (a null branch in `over` is a detached HEAD). */
const input = (
  over: Partial<SyncInput>,
  branch?: Partial<NonNullable<SyncInput["branch"]>>,
): SyncInput => {
  const merged: SyncInput = { ...base, ...over };
  return branch && merged.branch ? { ...merged, branch: { ...merged.branch, ...branch } } : merged;
};

describe("fetchPlan", () => {
  it("fetches while a remote is known and nothing runs", () => {
    expect(fetchPlan(base)).toEqual({ kind: "fetch" });
    // An upstream names a remote before the list is read.
    expect(fetchPlan(input({ remotes: null }))).toEqual({ kind: "fetch" });
  });

  it("refuses with no repository, no remote, the remotes unread or a command running", () => {
    expect(fetchPlan(input({ ready: false }))).toEqual({ kind: "refused", reason: "closed" });
    expect(fetchPlan(input({ remotes: [] }))).toEqual({ kind: "refused", reason: "noRemote" });
    expect(fetchPlan(input({ remotes: null }, { upstream: null }))).toEqual({
      kind: "refused",
      reason: "readingRemotes",
    });
    expect(fetchPlan(input({ busy: true }))).toEqual({ kind: "refused", reason: "busy" });
  });

  it("fetches on a detached HEAD", () => {
    expect(fetchPlan(input({ branch: null }))).toEqual({ kind: "fetch" });
  });
});

describe("pullPlan", () => {
  it("fast-forwards a branch that is behind, with the count", () => {
    expect(pullPlan(input({}, { behind: 3 }))).toEqual({
      kind: "pull",
      branch: "main",
      upstream: "origin/main",
      behind: 3,
    });
    // Level or ahead only: the pull may still bring what the last fetch did not see.
    expect(pullPlan(input({}, { ahead: 2 }))).toMatchObject({ kind: "pull", behind: 0 });
    expect(pullPlan(input({}, { ahead: null, behind: null }))).toMatchObject({
      kind: "pull",
      behind: 0,
    });
  });

  it("leaves a diverged branch to the dialog", () => {
    expect(pullPlan(input({}, { ahead: 1, behind: 2 }))).toEqual({
      kind: "dialog",
      branch: "main",
      upstream: "origin/main",
      behind: 2,
    });
  });

  it("refuses with its reason, the branch's before what runs", () => {
    expect(pullPlan(input({ ready: false }))).toEqual({ kind: "refused", reason: "closed" });
    expect(pullPlan(input({ branch: null, busy: true }))).toEqual({
      kind: "refused",
      reason: "detached",
    });
    // A rebase detaches HEAD: the operation is what to say.
    expect(pullPlan(input({ branch: null, operation: true }))).toEqual({
      kind: "refused",
      reason: "operation",
    });
    expect(pullPlan(input({}, { unborn: true, upstream: null }))).toEqual({
      kind: "refused",
      reason: "unborn",
    });
    expect(pullPlan(input({}, { gone: true, ahead: null, behind: null }))).toEqual({
      kind: "refused",
      reason: "upstreamGone",
    });
    expect(pullPlan(input({ remotes: [] }, { upstream: null }))).toEqual({
      kind: "refused",
      reason: "noRemote",
    });
    expect(pullPlan(input({}, { upstream: null }))).toEqual({
      kind: "refused",
      reason: "noUpstream",
    });
    expect(pullPlan(input({ operation: true, busy: true }))).toEqual({
      kind: "refused",
      reason: "operation",
    });
    expect(pullPlan(input({ busy: true }))).toEqual({ kind: "refused", reason: "busy" });
  });
});

describe("syncPushPlan", () => {
  it("pushes a branch ahead of its upstream, with the count", () => {
    expect(syncPushPlan(input({}, { ahead: 2 }))).toEqual({
      kind: "push",
      remote: "origin",
      branch: "main",
      publish: false,
      ahead: 2,
    });
  });

  it("publishes a branch without upstream to the only remote", () => {
    expect(
      syncPushPlan(input({}, { name: "claude/fix-auth", upstream: null, ahead: null })),
    ).toEqual({
      kind: "push",
      remote: "origin",
      branch: "claude/fix-auth",
      publish: true,
      ahead: 0,
    });
  });

  it("leaves the remote to the dialog when several could take the branch", () => {
    expect(syncPushPlan(input({ remotes: ["origin", "upstream"] }, { upstream: null }))).toEqual({
      kind: "dialog",
      branch: "main",
    });
  });

  it("pushes nothing in one click for a branch with no commit or an upstream gone", () => {
    expect(syncPushPlan(input({}, { unborn: true, upstream: null, ahead: null }))).toEqual({
      kind: "refused",
      reason: "unborn",
    });
    // Its counts unknown, the branch is not level: the push would bring back a deleted branch.
    expect(syncPushPlan(input({}, { gone: true, ahead: null, behind: null }))).toEqual({
      kind: "refused",
      reason: "upstreamGone",
    });
    expect(syncPushPlan(input({ branch: null, operation: true }))).toEqual({
      kind: "refused",
      reason: "operation",
    });
  });

  it("has nothing to push on a branch level with its upstream", () => {
    expect(syncPushPlan(base)).toEqual({ kind: "refused", reason: "level" });
    expect(syncPushPlan(input({ busy: true }))).toEqual({ kind: "refused", reason: "level" });
  });

  it("refuses with pushPlan's reasons, then while a command runs", () => {
    expect(syncPushPlan(input({ ready: false }))).toEqual({ kind: "refused", reason: "closed" });
    expect(syncPushPlan(input({ branch: null }))).toEqual({ kind: "refused", reason: "detached" });
    expect(syncPushPlan(input({ remotes: [] }, { upstream: null }))).toEqual({
      kind: "refused",
      reason: "noRemote",
    });
    expect(syncPushPlan(input({ remotes: null }, { upstream: null }))).toEqual({
      kind: "refused",
      reason: "readingRemotes",
    });
    expect(syncPushPlan(input({}, { upstream: "origin/trunk", ahead: 1 }))).toEqual({
      kind: "refused",
      reason: "renamedUpstream",
    });
    expect(syncPushPlan(input({ operation: true, busy: true }, { ahead: 1 }))).toEqual({
      kind: "refused",
      reason: "operation",
    });
    expect(syncPushPlan(input({ busy: true }, { ahead: 1 }))).toEqual({
      kind: "refused",
      reason: "busy",
    });
  });
});
