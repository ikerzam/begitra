import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Ref } from "@/ipc/schemas";
import { fakeBackend, fakeCommit, settled, writeGate } from "@/test/backend";

import { useRecentBranchesStore } from "./recentBranches";
import { useRepoStore } from "./repo";

/** The two local branches of the fake listing, HEAD on `current`. */
function branches(current: string): Ref[] {
  return ["main", "develop"].map((name) => ({
    name,
    fullName: `refs/heads/${name}`,
    kind: "local-branch",
    target: fakeCommit(0).hash,
    isCurrent: name === current,
    upstream: null,
    ahead: null,
    behind: null,
    worktree: name === current ? "/r" : null,
    message: null,
    committedAt: null,
  }));
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  clearMocks();
});

describe("recent branches store", () => {
  it("reads them after each listing of the refs", async () => {
    const calls = fakeBackend({ recentBranches: ["develop", "claude/fix-auth"] });
    const recent = useRecentBranchesStore();
    const repo = useRepoStore();
    await repo.open("/r");
    await settled();
    expect(recent.names).toEqual(["develop", "claude/fix-auth"]);
    expect(recent.previous).toBe("develop");
    const reads = () => calls.filter((call) => call.cmd === "recent_branches").length;
    const before = reads();
    const held = recent.names;
    await repo.refreshRefs();
    await settled();
    expect(reads()).toBe(before + 1);
    expect(calls.find((call) => call.cmd === "recent_branches")?.args["repo"]).toBe("/r");
    // The same answer keeps the list it holds, so nothing built on it moves.
    expect(recent.names).toBe(held);
  });

  it("offers only the names the listing has as other local branches", async () => {
    // `main` is HEAD's branch in the listing, and `gone` is not in it.
    fakeBackend({ recentBranches: ["main", "gone", "develop"] });
    const recent = useRecentBranchesStore();
    await useRepoStore().open("/r");
    await settled();
    expect(recent.names).toEqual(["main", "gone", "develop"]);
    expect(recent.branches).toEqual(["develop"]);
    expect(recent.previous).toBe("develop");
  });

  it("drops the list with another repository, and an older read that answers late", async () => {
    const gate = writeGate();
    const calls = fakeBackend({ recentBranches: ["develop"], recentGate: gate, rootIsPath: true });
    const recent = useRecentBranchesStore();
    const repo = useRepoStore();
    await repo.open("/a");
    await settled();
    gate.release();
    await settled();
    expect(recent.names).toEqual(["develop"]);
    // A read of `/a` on its way when `/b` opens.
    await repo.refreshRefs();
    await settled();
    expect(gate.waiting).toEqual(["recent_branches"]);
    await repo.open("/b");
    await settled();
    expect(recent.names).toEqual([]);
    expect(gate.waiting.length).toBeGreaterThan(1);
    while (gate.waiting.length > 1) {
      gate.release();
      await settled();
      expect(recent.names).toEqual([]);
    }
    gate.release();
    await settled();
    expect(recent.names).toEqual(["develop"]);
    const reads = calls.filter((call) => call.cmd === "recent_branches");
    expect(reads.at(-1)?.args["repo"]).toBe("/b");
  });

  it("offers none after a write here moves HEAD, until the read after the next listing", async () => {
    const gate = writeGate();
    const options = { recentBranches: ["develop"], recentGate: gate, refs: branches("main") };
    fakeBackend(options);
    const recent = useRecentBranchesStore();
    const repo = useRepoStore();
    await repo.open("/r");
    await settled();
    gate.release();
    await settled();
    expect(recent.previous).toBe("develop");
    // A read on its way when HEAD moves answers for HEAD before the move.
    await repo.refreshRefs();
    await settled();
    expect(gate.waiting).toEqual(["recent_branches"]);
    recent.headMoved();
    expect(recent.branches).toEqual([]);
    expect(recent.previous).toBeNull();
    gate.release();
    await settled();
    expect(recent.previous).toBeNull();
    // The listing after the switch to `develop`, then the read that follows it.
    options.refs = branches("develop");
    options.recentBranches = ["main"];
    await repo.refreshRefs();
    await settled();
    expect(recent.previous).toBeNull();
    gate.release();
    await settled();
    expect(recent.previous).toBe("main");
  });

  it("lists none when the read fails", async () => {
    fakeBackend({ recentBranches: ["develop"], failRecentBranches: true });
    const recent = useRecentBranchesStore();
    const repo = useRepoStore();
    await repo.open("/r");
    await settled();
    expect(recent.names).toEqual([]);
    expect(recent.previous).toBeNull();
  });
});
