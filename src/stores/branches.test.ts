import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Ref } from "@/ipc/schemas";
import {
  FAKE_OUTCOME_HASH,
  FAKE_TAG_OBJECT,
  fakeBackend,
  fakeCommit,
  settled,
  writeGate,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";

import { AppError } from "@/ipc/errors";

import { isUnmergedDelete, useBranchesStore } from "./branches";
import { useLocalChangesStore } from "./localChanges";
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

  it("asks how local changes go when git refuses a switch, then carries them over", async () => {
    const calls = await open({ dirtySwitch: true });
    const branches = useBranchesStore();
    const localChanges = useLocalChangesStore();
    const done = await branches.checkout({ kind: "branch", name: "develop" });
    expect(done).toBe(false);
    expect(localChanges.prompt).toMatchObject({ operation: "switch", target: "develop" });
    expect(localChanges.prompt?.detail).toContain("would be overwritten");
    expect(useToastsStore().toasts).toHaveLength(0);
    await localChanges.choose("carry");
    await settled();
    expect(localChanges.prompt).toBeNull();
    expect(of(calls, "switch").map((call) => call.args["localChanges"])).toEqual([
      "refuse",
      "carry",
    ]);
    expect(useToastsStore().toasts.at(-1)?.key).toBe("localChanges.switchedWith");
    expect(localChanges.kept).toBeNull();
  });

  it("leaves the changes in a stash, its toast naming it", async () => {
    const stash = "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7";
    const calls = await open({
      dirtySwitch: true,
      switched: { stash, conflicts: [], kept: null },
    });
    const localChanges = useLocalChangesStore();
    await useBranchesStore().checkout({ kind: "branch", name: "develop" });
    await localChanges.choose("leave");
    await settled();
    expect(of(calls, "switch").at(-1)?.args["localChanges"]).toBe("leave");
    const toast = useToastsStore().toasts.at(-1);
    expect(toast?.key).toBe("localChanges.switchedLeft");
    expect(toast?.params).toEqual({ name: "develop", hash: "c4d5e6f" });
    expect(localChanges.kept).toBeNull();
  });

  it("opens the changes screen when the carried changes come back with conflicts", async () => {
    const stash = "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7";
    await open({
      dirtySwitch: true,
      switched: { stash, conflicts: [{ path: "src/a.ts", kind: "both-modified" }], kept: null },
    });
    const localChanges = useLocalChangesStore();
    await useBranchesStore().checkout({ kind: "branch", name: "develop" });
    await localChanges.choose("carry");
    await settled();
    expect(localChanges.kept).toEqual({ root: "/r", stash });
    expect(useShellStore().layoutMode).toBe("changes");
    expect(useToastsStore().toasts).toHaveLength(0);
  });

  it("says in a toast that stays when what was staged came back unstaged", async () => {
    await open({
      dirtySwitch: true,
      switched: { stash: null, conflicts: [], kept: null, unstaged: true },
    });
    await useBranchesStore().checkout({ kind: "branch", name: "develop" });
    await useLocalChangesStore().choose("carry");
    await settled();
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      kind: "info",
      key: "localChanges.switchedUnstaged",
      params: { name: "develop" },
      sticky: true,
    });
  });

  it("names a detached HEAD in the toast of a carry", async () => {
    await open({ dirtySwitch: true });
    await useBranchesStore().checkout({ kind: "detached", rev: "refs/tags/v1.2.0" });
    await useLocalChangesStore().choose("carry");
    await settled();
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      key: "localChanges.switchedWithDetached",
      params: { name: "v1.2.0", hash: "" },
    });
  });

  it("keeps the banner out when git kept part of the changes that came back with conflicts", async () => {
    const stash = "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7";
    await open({
      dirtySwitch: true,
      switched: {
        stash,
        conflicts: [{ path: "src/a.ts", kind: "both-modified" }],
        kept: "new.txt already exists, no checkout",
      },
    });
    const localChanges = useLocalChangesStore();
    await useBranchesStore().checkout({ kind: "branch", name: "develop" });
    await localChanges.choose("carry");
    await settled();
    // The stash holds what no file does: its banner's drop would lose it.
    expect(localChanges.kept).toBeNull();
    expect(useShellStore().layoutMode).toBe("changes");
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      key: "localChanges.switchedKept",
      sticky: true,
      output: "new.txt already exists, no checkout",
    });
  });

  it("says in a toast that stays what git reported after a switch it made", async () => {
    await open({
      switched: { stash: null, conflicts: [], kept: null, notice: "post-checkout says no" },
    });
    expect(await useBranchesStore().checkout({ kind: "branch", name: "develop" })).toBe(true);
    expect(useToastsStore().toasts).toHaveLength(1);
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      kind: "error",
      key: "branches.switchNotice",
      params: { name: "develop" },
      sticky: true,
      output: "post-checkout says no",
    });
  });

  it("keeps the banner for carried changes back with conflicts when only a hook failed", async () => {
    const stash = "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7";
    await open({
      dirtySwitch: true,
      switched: {
        stash,
        conflicts: [{ path: "src/a.ts", kind: "both-modified" }],
        kept: null,
        notice: "post-checkout says no",
      },
    });
    const localChanges = useLocalChangesStore();
    await useBranchesStore().checkout({ kind: "branch", name: "develop" });
    await localChanges.choose("carry");
    await settled();
    expect(localChanges.kept).toEqual({ root: "/r", stash });
    expect(useToastsStore().toasts.map((toast) => toast.key)).toEqual(["branches.switchNotice"]);
  });

  it("says in a toast that stays when git kept part of the carried changes", async () => {
    const stash = "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7";
    await open({
      dirtySwitch: true,
      switched: { stash, conflicts: [], kept: "new.txt already exists, no checkout" },
    });
    await useBranchesStore().checkout({ kind: "branch", name: "develop" });
    await useLocalChangesStore().choose("carry");
    await settled();
    const toast = useToastsStore().toasts.at(-1);
    expect(toast).toMatchObject({
      key: "localChanges.switchedKept",
      sticky: true,
      output: "new.txt already exists, no checkout",
    });
  });

  it("sets the changes aside and merges again when local changes refuse a merge", async () => {
    const calls = await open({ localChangesIn: ["merge"] });
    const localChanges = useLocalChangesStore();
    expect(await useBranchesStore().merge("develop", "default")).toBeNull();
    expect(localChanges.prompt).toMatchObject({ operation: "merge", target: "develop" });
    expect(useToastsStore().toasts).toHaveLength(0);
    await localChanges.choose("aside");
    await settled();
    expect(of(calls, "merge").map((call) => call.args["autostash"])).toEqual([false, true]);
  });

  it("names a ref the palette passes in full by its short name", async () => {
    await open({ localChangesIn: ["merge", "rebase"] });
    const localChanges = useLocalChangesStore();
    await useBranchesStore().merge("refs/heads/develop", "default");
    expect(localChanges.prompt).toMatchObject({ operation: "merge", target: "develop" });
    localChanges.dismiss();
    await useBranchesStore().rebase("refs/remotes/origin/main");
    expect(localChanges.prompt).toMatchObject({ operation: "rebase", target: "origin/main" });
  });

  it("keeps the stash git's autostash kept with conflicts, and toasts one kept without", async () => {
    const stash = "c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7";
    await open({
      outcome: {
        kind: "conflicts",
        hash: null,
        conflicts: [{ path: "src/a.ts", kind: "both-modified" }],
        stash,
      },
    });
    const localChanges = useLocalChangesStore();
    await useBranchesStore().merge("develop", "default", true);
    expect(localChanges.kept).toEqual({ root: "/r", stash });
    clearMocks();
    localChanges.forget();
    const other = "d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7c4";
    fakeBackend({
      outcome: { kind: "done", hash: FAKE_OUTCOME_HASH, conflicts: [], stash: other },
    });
    await useBranchesStore().rebase("develop", true);
    expect(localChanges.kept).toBeNull();
    expect(useToastsStore().toasts.map((toast) => toast.key)).toContain("localChanges.stashKept");
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
    // What the tag pointed at puts it back, the only way back (tags have no reflog): the toast
    // stays until dismissed.
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      output: `git tag v1 ${FAKE_TAG_OBJECT}`,
      sticky: true,
    });
    // A name a shell would read goes in quotes in the command the user copies.
    await branches.deleteTag("v2;echo");
    expect(useToastsStore().toasts.at(-1)?.output).toBe(`git tag 'v2;echo' ${FAKE_TAG_OBJECT}`);
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
