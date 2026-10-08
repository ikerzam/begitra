import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Ref } from "@/ipc/schemas";
import { fakeBackend, fakeCommit, settled, writeGate, type Call } from "@/test/backend";

import { useContainedStore } from "./contained";
import { useRepoStore } from "./repo";
import { memoryStorage, useSettingsStore } from "./settings";

const main: Ref = {
  name: "main",
  fullName: "refs/heads/main",
  kind: "local-branch",
  target: fakeCommit(0).hash,
  isCurrent: true,
  upstream: null,
  ahead: null,
  behind: null,
  worktree: "/r",
  message: null,
  committedAt: null,
};

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "linux");
});

afterEach(() => {
  clearMocks();
});

const of = (calls: Call[], cmd: string) => calls.filter((call) => call.cmd === cmd);

describe("useContainedStore", () => {
  it("reads the refs that hold a commit and keeps the answer with it", async () => {
    const third = fakeCommit(2).hash;
    const calls = fakeBackend({
      refs: [main],
      containing: { [third]: ["refs/heads/main", "refs/tags/v1"] },
    });
    const repo = useRepoStore();
    await repo.open("/r");
    await settled();
    const contained = useContainedStore();
    expect(contained.of(third)).toBeNull();
    const read = contained.find(third);
    expect(contained.of(third)?.kind).toBe("reading");
    await read;
    expect(contained.of(third)).toEqual({
      kind: "answered",
      refs: ["refs/heads/main", "refs/tags/v1"],
    });
    expect(of(calls, "refs_containing")[0]?.args).toMatchObject({ repo: "/r", commit: third });
  });

  it("stops the read when another commit is selected, and that commit asks again", async () => {
    const gate = writeGate();
    const calls = fakeBackend({ refs: [main], containingGate: gate });
    const repo = useRepoStore();
    await repo.open("/r");
    await settled();
    repo.select(0);
    const first = repo.commits[0]!.hash;
    const contained = useContainedStore();
    void contained.find(first);
    await settled();
    expect(gate.waiting).toEqual(["refs_containing"]);
    repo.select(1);
    await settled();
    const opId = of(calls, "refs_containing")[0]?.args["opId"];
    expect(of(calls, "cancel_operation").map((call) => call.args["opId"])).toContain(opId);
    expect(contained.of(first)).toBeNull();
    // A late answer of the stopped read changes nothing.
    gate.release();
    await settled();
    expect(contained.of(first)).toBeNull();
  });

  it("says why a read failed", async () => {
    const gate = writeGate();
    fakeBackend({ refs: [main], containingGate: gate });
    const repo = useRepoStore();
    await repo.open("/r");
    await settled();
    const contained = useContainedStore();
    const read = contained.find(fakeCommit(1).hash);
    await settled();
    gate.refuse();
    await read;
    const answer = contained.of(fakeCommit(1).hash);
    expect(answer?.kind).toBe("failed");
    expect(answer?.kind === "failed" && answer.error.code).toBe("git.cli_failed");
  });

  it("forgets the answers when the refs move or another repository opens", async () => {
    const options = { refs: [main], containing: { [fakeCommit(1).hash]: ["refs/heads/main"] } };
    fakeBackend(options);
    const repo = useRepoStore();
    await repo.open("/r");
    await settled();
    const contained = useContainedStore();
    await contained.find(fakeCommit(1).hash);
    expect(contained.of(fakeCommit(1).hash)?.kind).toBe("answered");
    // The same refs listed again keep the answer.
    await repo.refreshRefs();
    await settled();
    expect(contained.of(fakeCommit(1).hash)?.kind).toBe("answered");
    // A branch moved: the answer may not hold any more.
    options.refs = [{ ...main, target: fakeCommit(5).hash }];
    await repo.refreshRefs();
    await settled();
    expect(contained.of(fakeCommit(1).hash)).toBeNull();
    await contained.find(fakeCommit(1).hash);
    await repo.open("/other");
    await settled();
    expect(contained.of(fakeCommit(1).hash)).toBeNull();
  });

  it("reads the commit on screen again when a branch moves, and keeps every answer through HEAD and the stashes", async () => {
    const stash: Ref = {
      ...main,
      name: "stash@{0}",
      fullName: "refs/stash",
      kind: "stash",
      isCurrent: false,
      target: fakeCommit(7).hash,
    };
    const options = { refs: [main], containing: {} as Record<string, string[]> };
    const calls = fakeBackend(options);
    const repo = useRepoStore();
    await repo.open("/r");
    await settled();
    repo.select(2);
    const shown = repo.commits[2]!.hash;
    options.containing[shown] = ["refs/heads/main"];
    const contained = useContainedStore();
    await contained.find(shown);
    await contained.find(fakeCommit(9).hash);
    expect(of(calls, "refs_containing")).toHaveLength(2);
    // A stash pushed and HEAD detached: the answers stand.
    options.refs = [main, stash, { ...main, kind: "head", name: "HEAD", fullName: "HEAD" }];
    await repo.refreshRefs();
    await settled();
    expect(contained.of(shown)?.kind).toBe("answered");
    expect(of(calls, "refs_containing")).toHaveLength(2);
    // A branch moved: the answers go, and the commit on screen reads again.
    options.refs = [{ ...main, target: fakeCommit(5).hash }];
    await repo.refreshRefs();
    await settled();
    expect(of(calls, "refs_containing")).toHaveLength(3);
    expect(of(calls, "refs_containing").at(-1)?.args["commit"]).toBe(shown);
    expect(contained.of(shown)?.kind).toBe("answered");
    expect(contained.of(fakeCommit(9).hash)).toBeNull();
  });
});
