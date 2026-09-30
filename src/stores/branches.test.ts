import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Ref } from "@/ipc/schemas";
import {
  FAKE_TAG_OBJECT,
  fakeBackend,
  fakeCommit,
  settled,
  writeGate,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";

import { AppError } from "@/ipc/errors";

import { isDirtySwitch, isUnmergedDelete, useBranchesStore } from "./branches";
import { useOperationsStore } from "./operations";
import { useRepoStore } from "./repo";
import { useSequencerStore } from "./sequencer";
import { memoryStorage, useSettingsStore } from "./settings";
import { useShellStore } from "./shell";
import { useToastsStore } from "./toasts";

async function open(options: FakeBackendOptions = {}): Promise<Call[]> {
  const calls = fakeBackend(options);
  await useRepoStore().open("/r");
  await settled();
  return calls;
}

function of(calls: Call[], cmd: string): Call[] {
  return calls.filter((call) => call.cmd === cmd);
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  clearMocks();
});

describe("branches store", () => {
  it("recognises git's refusals in its own words", () => {
    const error = (detail: string) => new AppError("git.cli_failed", "failed", detail);
    expect(isDirtySwitch(error("Your local changes would be overwritten by checkout"))).toBe(true);
    expect(isDirtySwitch(error("fatal: invalid reference: nope"))).toBe(false);
    expect(isUnmergedDelete(error("error: the branch 'x' is not fully merged"))).toBe(true);
    expect(isUnmergedDelete(error("error: branch 'x' not found"))).toBe(false);
  });

  it("checks out a branch, refreshes the refs, lists the history again and toasts", async () => {
    const calls = await open();
    const branches = useBranchesStore();
    const walksBefore = of(calls, "walk_commits").length;
    const done = await branches.checkout({ kind: "branch", name: "develop" });
    await settled();
    expect(done).toBe(true);
    expect(of(calls, "switch")[0]?.args["target"]).toEqual({ kind: "branch", name: "develop" });
    expect(of(calls, "list_refs").length).toBeGreaterThanOrEqual(2);
    expect(of(calls, "walk_commits").length).toBe(walksBefore + 1);
    const toast = useToastsStore().toasts.at(-1);
    expect(toast?.key).toBe("branches.switched");
    expect(toast?.params).toEqual({ name: "develop" });
    expect(useOperationsStore().current).toBeUndefined();
  });

  it("refuses a write while another runs, with a toast that says so", async () => {
    const calls = await open();
    const branches = useBranchesStore();
    const first = branches.checkout({ kind: "branch", name: "develop" });
    expect(await branches.checkout({ kind: "branch", name: "main" })).toBe(false);
    expect(useToastsStore().toasts.at(-1)?.key).toBe("branches.busy");
    expect(await first).toBe(true);
    await settled();
    expect(of(calls, "switch")).toHaveLength(1);
  });

  it("offers Stash and switch when git refuses a dirty switch, then stashes and switches", async () => {
    await open({ dirtySwitch: true });
    const branches = useBranchesStore();
    const done = await branches.checkout({ kind: "branch", name: "develop" });
    expect(done).toBe(false);
    expect(branches.prompt).toMatchObject({ kind: "dirtySwitch", target: { name: "develop" } });
    expect((branches.prompt as { output: string }).output).toContain("would be overwritten");
    expect(useToastsStore().toasts).toHaveLength(0);
    clearMocks();
    const clean = fakeBackend();
    await branches.stashAndSwitch({ kind: "branch", name: "develop" });
    await settled();
    expect(branches.prompt).toBeNull();
    expect(of(clean, "stash_push")[0]?.args["request"]).toEqual({
      message: null,
      includeUntracked: true,
      paths: [],
    });
    expect(of(clean, "switch")).toHaveLength(1);
  });

  it("creates a branch, checking it out when asked, and renames one", async () => {
    const calls = await open();
    const branches = useBranchesStore();
    branches.ask({ kind: "create", start: "main", startLabel: "main" });
    await branches.create("feature/x", "main", true);
    await settled();
    expect(branches.prompt).toBeNull();
    expect(of(calls, "branch_create")[0]?.args).toMatchObject({
      name: "feature/x",
      start: "main",
      checkout: true,
    });
    expect(of(calls, "walk_commits").length).toBe(2);
    await branches.rename("feature/x", "feature/y");
    expect(of(calls, "branch_rename")[0]?.args).toMatchObject({
      from: "feature/x",
      to: "feature/y",
    });
  });

  it("shows a deleted branch, a renamed one and a deleted tag before the refs are listed again", async () => {
    const ref = (name: string, kind: Ref["kind"]): Ref => ({
      name,
      fullName: `${kind === "tag" ? "refs/tags/" : "refs/heads/"}${name}`,
      kind,
      target: fakeCommit(0).hash,
      isCurrent: name === "main",
      upstream: null,
      ahead: null,
      behind: null,
      worktree: null,
      message: null,
      committedAt: null,
    });
    const options: FakeBackendOptions = {
      refs: [
        ref("main", "local-branch"),
        ref("develop", "local-branch"),
        ref("feature/x", "local-branch"),
        ref("v1", "tag"),
      ],
    };
    await open(options);
    // The listings after the writes wait: what shows meanwhile is git's answer.
    const gate = writeGate();
    options.listingGate = gate;
    const repo = useRepoStore();
    const branches = useBranchesStore();
    const listed = () => repo.refs.map((entry) => entry.fullName);
    expect(await branches.remove("feature/x", false)).toBe(true);
    expect(listed()).toEqual(["refs/heads/main", "refs/heads/develop", "refs/tags/v1"]);
    expect(await branches.rename("develop", "dev")).toBe(true);
    expect(listed()).toEqual(["refs/heads/main", "refs/heads/dev", "refs/tags/v1"]);
    expect(await branches.deleteTag("v1")).toBe(true);
    expect(listed()).toEqual(["refs/heads/main", "refs/heads/dev"]);
    expect(gate.waiting).toEqual(["list_refs", "list_refs", "list_refs"]);
  });

  it("asks Delete anyway when git refuses an unmerged branch, then forces", async () => {
    const calls = await open({ unmergedBranch: true });
    const branches = useBranchesStore();
    expect(await branches.remove("develop", false)).toBe(false);
    expect(branches.prompt).toMatchObject({ kind: "delete", name: "develop", force: true });
    expect(await branches.remove("develop", true)).toBe(true);
    expect(of(calls, "branch_delete").map((call) => call.args["force"])).toEqual([false, true]);
    expect(useToastsStore().toasts.at(-1)?.key).toBe("branches.deleted");
  });

  it("merges: a clean outcome toasts and moves the graph, conflicts open the changes screen", async () => {
    const calls = await open();
    const branches = useBranchesStore();
    const outcome = await branches.merge("develop", "default");
    await settled();
    expect(outcome?.kind).toBe("done");
    expect(of(calls, "merge")[0]?.args).toMatchObject({ rev: "develop", mode: "default" });
    expect(useToastsStore().toasts.at(-1)?.key).toBe("branches.merged");
    expect(useShellStore().layoutMode).toBe("graph");
    clearMocks();
    fakeBackend({
      outcome: {
        kind: "conflicts",
        hash: null,
        conflicts: [{ path: "src/a.ts", kind: "both-modified" }],
      },
      operation: "merge",
      conflicts: [{ path: "src/a.ts", kind: "both-modified" }],
    });
    const stopped = await branches.merge("develop", "no-ff");
    await settled();
    expect(stopped?.kind).toBe("conflicts");
    expect(useShellStore().layoutMode).toBe("changes");
    const sequencer = useSequencerStore();
    expect(sequencer.operation).toBe("merge");
    expect(sequencer.conflicts).toEqual([{ path: "src/a.ts", kind: "both-modified" }]);
    expect(sequencer.inProgress).toBe(true);
  });

  it("resets, cherry-picks, reverts, tags and sets the upstream through the bridge", async () => {
    const calls = await open();
    const branches = useBranchesStore();
    await branches.reset("HEAD~1", "hard");
    expect(of(calls, "reset")[0]?.args).toMatchObject({ rev: "HEAD~1", mode: "hard" });
    await branches.cherryPick(["a".repeat(40)]);
    expect(of(calls, "cherry_pick")[0]?.args["revs"]).toEqual(["a".repeat(40)]);
    await branches.revert(["b".repeat(40)]);
    expect(of(calls, "revert")).toHaveLength(1);
    await branches.tag("v1", "main", "release");
    expect(of(calls, "tag_create")[0]?.args).toMatchObject({
      name: "v1",
      rev: "main",
      message: "release",
    });
    await branches.deleteTag("v1");
    expect(of(calls, "tag_delete")[0]?.args["name"]).toBe("v1");
    // What the tag pointed at puts it back.
    expect(useToastsStore().toasts.at(-1)?.output).toBe(`git tag v1 ${FAKE_TAG_OBJECT}`);
    await branches.setUpstream("main", "origin/main");
    expect(of(calls, "set_upstream")[0]?.args).toMatchObject({
      branch: "main",
      upstream: "origin/main",
    });
    expect(useToastsStore().toasts.map((toast) => toast.key)).toEqual([
      "branches.resetDone",
      "branches.cherryPicked",
      "branches.reverted",
      "branches.tagged",
      "branches.tagDeletedWas",
    ]);
  });

  it("turns another refusal into an error toast with git's output", async () => {
    await open();
    clearMocks();
    fakeBackend();
    const branches = useBranchesStore();
    const { mockIPC } = await import("@tauri-apps/api/mocks");
    mockIPC(() =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
      Promise.reject({
        code: "git.cli_failed",
        message: "git merge failed",
        detail: "fatal: refusing to merge unrelated histories",
      }),
    );
    expect(await branches.merge("orphan", "default")).toBeNull();
    const toast = useToastsStore().toasts.at(-1);
    expect(toast?.kind).toBe("error");
    expect(toast?.key).toBe("branches.failed");
    expect(toast?.output).toContain("unrelated histories");
    expect(branches.busy).toBeNull();
  });
});
