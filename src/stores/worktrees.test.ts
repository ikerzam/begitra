import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { worktreeLock } from "@/ipc/commands";
import { fakeBackend, fakeCommit, fakeWorktrees, settled, type Call } from "@/test/backend";

import { useCompareStore } from "./compare";
import { useRepoStore } from "./repo";
import { memoryStorage, useSettingsStore } from "./settings";
import { useShellStore } from "./shell";
import { useWorktreesStore } from "./worktrees";

const summaries = {
  "/wt/claude-auth": {
    currentBranch: "claude/fix-auth",
    detached: false,
    ahead: null,
    behind: null,
    lastCommitAt: 1_699_000_000,
    dirty: true,
  },
};

async function openDashboard(calls?: Call[]) {
  const backend = calls ?? fakeBackend({ worktrees: fakeWorktrees(), summaries });
  await useRepoStore().open("/r");
  await settled();
  const worktrees = useWorktreesStore();
  await worktrees.show();
  await settled();
  return { worktrees, calls: backend };
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  clearMocks();
});

describe("worktrees store", () => {
  it("lists the worktrees with the index's dirty flag and the counts against main", async () => {
    const { worktrees, calls } = await openDashboard();
    expect(useShellStore().layoutMode).toBe("worktrees");
    expect(worktrees.rows.map((row) => row.name)).toEqual(["r", "claude-auth", "gone"]);
    const main = worktrees.rows[0];
    expect(main?.isMain).toBe(true);
    expect(worktrees.mainBranch).toBe("main");
    const linked = worktrees.rows[1];
    expect(linked?.dirty).toBe(true);
    expect(linked?.lastCommitAt).toBe(1_699_000_000);
    // One comparison per linked worktree: main against its branch.
    const compares = calls.filter((call) => call.cmd === "compare");
    expect(compares.map((call) => [call.args["a"], call.args["b"]])).toEqual([
      ["main", "claude/fix-auth"],
      ["main", "gone"],
    ]);
    expect([linked?.ahead, linked?.behind]).toEqual([3, 4]);
    // The index entries of the linked worktrees were refreshed.
    const refreshed = calls.filter((call) => call.cmd === "refresh_repository");
    expect(refreshed.map((call) => call.args["path"])).toEqual(["/wt/claude-auth", "/wt/gone"]);
    expect(worktrees.prunable).toEqual(["/wt/gone"]);
    expect(worktrees.rows[2]?.locked).toBe(true);
    expect(worktrees.rows[2]?.lockReason).toBe("review");
  });

  it("proposes a path under the worktree folder, slashes as dashes", async () => {
    const { worktrees } = await openDashboard();
    expect(worktrees.worktreeFolder).toBe("/r.worktrees");
    expect(worktrees.defaultPath("claude/fix-auth")).toBe("/r.worktrees/claude-fix-auth");
    await useSettingsStore().update("worktreeFolder", "C:\\wt");
    expect(worktrees.worktreeFolder).toBe("C:\\wt");
    expect(worktrees.defaultPath("topic")).toBe("C:\\wt\\topic");
  });

  it("adds a worktree, reloads and selects it", async () => {
    const { worktrees, calls } = await openDashboard();
    worktrees.openAdd();
    expect(worktrees.addOpen).toBe(true);
    const added = await worktrees.add({
      path: "/r.worktrees/topic",
      branch: { kind: "new", name: "topic", start: "main" },
    });
    await settled();
    expect(added).toBe("/r.worktrees/topic");
    expect(worktrees.addOpen).toBe(false);
    expect(worktrees.selected?.name).toBe("topic");
    expect(worktrees.rows.map((row) => row.name)).toEqual(["r", "claude-auth", "gone", "topic"]);
    const call = calls.find((c) => c.cmd === "worktree_add");
    expect(call?.args["request"]).toEqual({
      path: "/r.worktrees/topic",
      branch: { kind: "new", name: "topic", start: "main" },
    });
  });

  it("keeps git's refusal of an add as the error of the dialog", async () => {
    const calls = fakeBackend({
      worktrees: fakeWorktrees(),
      summaries,
      failWorktreeAdd: true,
    });
    const { worktrees } = await openDashboard(calls);
    worktrees.openAdd();
    const added = await worktrees.add({
      path: "/wt/develop",
      branch: { kind: "existing", name: "develop" },
    });
    expect(added).toBeNull();
    expect(worktrees.addOpen).toBe(true);
    expect(worktrees.error?.code).toBe("git.cli_failed");
    expect(worktrees.errorPath).toBe("/wt/develop");
    worktrees.clearError();
    expect(worktrees.error).toBeNull();
  });

  it("asks once more when git refuses a dirty removal, then removes with force", async () => {
    const calls = fakeBackend({
      worktrees: fakeWorktrees(),
      summaries,
      dirtyWorktrees: ["/wt/claude-auth"],
    });
    const { worktrees } = await openDashboard(calls);
    worktrees.select("/wt/claude-auth");
    worktrees.askRemove("/wt/claude-auth");
    expect(worktrees.prompt).toEqual({ kind: "remove", path: "/wt/claude-auth", force: false });
    expect(await worktrees.remove("/wt/claude-auth", false)).toBe(false);
    expect(worktrees.prompt).toEqual({ kind: "remove", path: "/wt/claude-auth", force: true });
    expect(worktrees.error).toBeNull();
    expect(await worktrees.remove("/wt/claude-auth", true)).toBe(true);
    await settled();
    expect(worktrees.prompt).toBeNull();
    expect(worktrees.selectedPath).toBeNull();
    expect(worktrees.rows.map((row) => row.name)).toEqual(["r", "gone"]);
    const removes = calls.filter((call) => call.cmd === "worktree_remove");
    expect(removes.map((call) => call.args["force"])).toEqual([false, true]);
  });

  it("prunes the entries whose folders are gone, locks and unlocks", async () => {
    const { worktrees, calls } = await openDashboard();
    worktrees.askPrune();
    expect(worktrees.prompt).toEqual({ kind: "prune", paths: ["/wt/gone"] });
    expect(await worktrees.prune()).toEqual(["/wt/gone"]);
    await settled();
    expect(worktrees.rows.map((row) => row.name)).toEqual(["r", "claude-auth"]);
    expect(worktrees.prunable).toEqual([]);
    worktrees.askPrune();
    expect(worktrees.prompt).toBeNull();

    worktrees.askLock("/wt/claude-auth");
    expect(worktrees.prompt).toEqual({ kind: "lock", path: "/wt/claude-auth" });
    expect(await worktrees.lock("/wt/claude-auth", "long build")).toBe(true);
    await settled();
    expect(worktrees.rows[1]?.locked).toBe(true);
    expect(worktrees.rows[1]?.lockReason).toBe("long build");
    expect(await worktrees.unlock("/wt/claude-auth")).toBe(true);
    await settled();
    expect(worktrees.rows[1]?.locked).toBe(false);
    const lock = calls.find((call) => call.cmd === "worktree_lock");
    expect(lock?.args).toMatchObject({ repo: "/r", path: "/wt/claude-auth", reason: "long build" });
  });

  it("opens the comparison of main with the worktree's branch", async () => {
    const { worktrees } = await openDashboard();
    await worktrees.compareWithMain("/wt/claude-auth");
    await settled();
    const compare = useCompareStore();
    expect(useShellStore().layoutMode).toBe("compare");
    expect(compare.endpoints).toEqual({
      a: { kind: "revision", rev: "main", label: "main" },
      b: { kind: "worktree", rev: "claude/fix-auth", label: "claude-auth" },
    });
  });

  it("follows the watcher: the list on refs and worktrees, the rows while the dashboard is up", async () => {
    const { worktrees, calls } = await openDashboard();
    const listings = () => calls.filter((call) => call.cmd === "list_worktrees").length;
    const counts = () => calls.filter((call) => call.cmd === "compare").length;
    let [listed, counted] = [listings(), counts()];
    // Refs that move no worktree (a fetch): the list is read again, no row is recounted.
    await worktrees.onRepoChanged(["refs"]);
    await settled();
    expect(listings()).toBe(listed + 1);
    expect(counts()).toBe(counted);
    // A worktree locked from a terminal: its row changed, the rows are counted again.
    await worktreeLock("/r", "/wt/claude-auth", null);
    await worktrees.onRepoChanged(["refs"]);
    await settled();
    expect(worktrees.rows.find((row) => row.path === "/wt/claude-auth")?.locked).toBe(true);
    expect(counts()).toBeGreaterThan(counted);
    // A worktree change reloads the dashboard whole.
    [listed, counted] = [listings(), counts()];
    await worktrees.onRepoChanged(["worktrees"]);
    await settled();
    expect(listings()).toBe(listed + 1);
    expect(counts()).toBeGreaterThan(counted);
    // Off the dashboard, the sidebar's list still follows, and nothing is counted.
    await useShellStore().setLayoutMode("graph");
    await settled();
    [listed, counted] = [listings(), counts()];
    await worktrees.onRepoChanged(["worktrees"]);
    await worktrees.onRepoChanged(["status"]);
    await settled();
    expect(listings()).toBe(listed + 1);
    expect(counts()).toBe(counted);
  });

  it("shows the tip's subject when the loaded history lists it", async () => {
    const { worktrees } = await openDashboard();
    expect(worktrees.rows[1]?.lastSubject).toBe(fakeCommit(4).subject);
    expect(worktrees.rows[0]?.head).toBe(fakeCommit(0).hash);
  });
});
