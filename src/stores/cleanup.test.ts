import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CleanupCandidate, Ref, Worktree } from "@/ipc/schemas";
import {
  fakeBackend,
  fakeCommit,
  fakeWorktrees,
  settled,
  writeGate,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";

import { useCleanupStore } from "./cleanup";
import { useOperationsStore } from "./operations";
import { useRepoStore } from "./repo";
import { memoryStorage, useSettingsStore } from "./settings";
import { useToastsStore } from "./toasts";

function local(name: string, n: number, worktree: string | null = null): Ref {
  return {
    name,
    fullName: `refs/heads/${name}`,
    kind: "local-branch",
    target: fakeCommit(n).hash,
    isCurrent: name === "main",
    upstream: null,
    ahead: null,
    behind: null,
    worktree,
    message: null,
    committedAt: fakeCommit(n).committer.time,
  };
}

const refs: Ref[] = [
  local("main", 0, "/r"),
  local("claude/new-task", 0, "/wt/new-task"),
  local("feature/tiles", 2),
  local("claude/fix-auth", 4, "/wt/claude-auth"),
  local("spike/maplibre", 5),
  local("review-2.4", 7, "/wt/review"),
];

function candidate(
  name: string,
  n: number,
  reason: CleanupCandidate["reason"],
  worktree: string | null = null,
): CleanupCandidate {
  return { name, tip: fakeCommit(n).hash, reason, remote: "origin", worktree };
}

const candidates: CleanupCandidate[] = [
  candidate("claude/fix-auth", 4, "gone-applied", "/wt/claude-auth"),
  candidate("claude/new-task", 0, "no-commits", "/wt/new-task"),
  candidate("feature/tiles", 2, "merged"),
  candidate("review-2.4", 7, "merged", "/wt/review"),
  candidate("spike/maplibre", 5, "gone"),
];

const review: Worktree = {
  path: "/wt/review",
  name: "review",
  head: fakeCommit(7).hash,
  branch: "review-2.4",
  detached: false,
  isMain: false,
  locked: true,
  lockReason: "agent at work",
  prunable: false,
  bare: false,
};

/** The options the fake backend reads at each call: a test changes them after the open. */
let backend: FakeBackendOptions = {};

async function open(options: FakeBackendOptions = {}): Promise<Call[]> {
  backend = {
    refs: refs.map((entry) => ({ ...entry })),
    worktrees: [...fakeWorktrees(), review],
    cleanup: { main: "main", candidates: candidates.map((entry) => ({ ...entry })) },
    ...options,
  };
  const calls = fakeBackend(backend);
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

describe("cleanup store", () => {
  it("lists the branches against main, ticking the merged and the applied ones", async () => {
    await open();
    const cleanup = useCleanupStore();
    await cleanup.open();
    expect(cleanup.isOpen).toBe(true);
    expect(cleanup.loading).toBe(false);
    expect(cleanup.main).toBe("main");
    expect(cleanup.rows.map((row) => [row.name, row.locked, row.committedAt])).toEqual([
      ["claude/fix-auth", false, fakeCommit(4).committer.time],
      ["claude/new-task", false, fakeCommit(0).committer.time],
      ["feature/tiles", false, fakeCommit(2).committer.time],
      ["review-2.4", true, fakeCommit(7).committer.time],
      ["spike/maplibre", false, fakeCommit(5).committer.time],
    ]);
    // A gone branch whose changes main lacks and a branch with no commits of its own (an
    // agent's new worktree) wait to be asked; a locked worktree cannot go.
    expect([...cleanup.ticked].sort()).toEqual(["claude/fix-auth", "feature/tiles"]);
    expect(cleanup.chosen.map((row) => row.name)).toEqual(["claude/fix-auth", "feature/tiles"]);
    expect(cleanup.chosenWorktrees).toBe(1);
  });

  it("leaves a gone branch the check did not answer unticked, with the warning", async () => {
    await open({
      cleanup: {
        main: "main",
        candidates: [
          candidate("claude/fix-auth", 4, "gone-applied", "/wt/claude-auth"),
          candidate("feature/tiles", 2, "merged"),
          candidate("spike/maplibre", 5, "gone-unchecked"),
        ],
      },
    });
    const cleanup = useCleanupStore();
    await cleanup.open();
    expect([...cleanup.ticked].sort()).toEqual(["claude/fix-auth", "feature/tiles"]);
    // Its changes may be missing from main: unknown, as for a gone branch main lacks.
    expect(cleanup.rows.map((row) => [row.name, row.warn])).toEqual([
      ["claude/fix-auth", false],
      ["feature/tiles", false],
      ["spike/maplibre", true],
    ]);
  });

  it("warns on a gone branch whose changes main lacks only", async () => {
    await open();
    const cleanup = useCleanupStore();
    await cleanup.open();
    expect(cleanup.rows.filter((row) => row.warn).map((row) => row.name)).toEqual([
      "spike/maplibre",
    ]);
  });

  it("opens again from nothing while it reads, the last listing gone", async () => {
    await open();
    const cleanup = useCleanupStore();
    await cleanup.open();
    cleanup.close();
    const gate = writeGate();
    backend.listingGate = gate;
    const reading = cleanup.open();
    await settled();
    expect(cleanup.loading).toBe(true);
    expect(cleanup.rows).toEqual([]);
    expect(cleanup.main).toBeNull();
    expect(cleanup.chosen).toEqual([]);
    while (gate.waiting.length > 0) gate.release();
    await reading;
    expect(cleanup.rows).toHaveLength(5);
  });

  it("keeps what the user ticked and unticked when it lists again", async () => {
    await open();
    const cleanup = useCleanupStore();
    await cleanup.open();
    cleanup.toggle("feature/tiles");
    cleanup.toggle("spike/maplibre");
    await cleanup.fetchAndPrune();
    await settled();
    expect([...cleanup.ticked].sort()).toEqual(["claude/fix-auth", "spike/maplibre"]);
    // A new opening starts from the defaults.
    cleanup.close();
    await cleanup.open();
    expect([...cleanup.ticked].sort()).toEqual(["claude/fix-auth", "feature/tiles"]);
  });

  it("closes when another repository opens", async () => {
    await open({ rootIsPath: true });
    const cleanup = useCleanupStore();
    await cleanup.open();
    expect(cleanup.rows).toHaveLength(5);
    await useRepoStore().open("/other");
    await settled();
    expect(cleanup.isOpen).toBe(false);
    expect(cleanup.rows).toEqual([]);
  });

  it("ticks and unticks a row, never a locked worktree's branch", async () => {
    await open();
    const cleanup = useCleanupStore();
    await cleanup.open();
    cleanup.toggle("spike/maplibre");
    cleanup.toggle("feature/tiles");
    cleanup.toggle("review-2.4");
    expect(cleanup.chosen.map((row) => row.name)).toEqual(["claude/fix-auth", "spike/maplibre"]);
    expect(cleanup.ticked.has("review-2.4")).toBe(false);
  });

  it("cancels the listing when the dialog closes, and drops its answer", async () => {
    const calls = await open();
    const cleanup = useCleanupStore();
    const listing = cleanup.open();
    cleanup.close();
    await listing;
    await settled();
    const opId = of(calls, "cleanup_candidates")[0]?.args["opId"];
    expect(of(calls, "cancel_operation").map((call) => call.args["opId"])).toContain(opId);
    expect(cleanup.isOpen).toBe(false);
    expect(cleanup.rows).toEqual([]);
    expect(cleanup.loading).toBe(false);
  });

  it("shows the listing's failure in the dialog, git's output one click away", async () => {
    await open({
      cleanupErrors: {
        list: { code: "git.cli_failed", message: "git for-each-ref failed", detail: "fatal: bad" },
      },
    });
    const cleanup = useCleanupStore();
    await cleanup.open();
    expect(cleanup.error?.message).toBe("git for-each-ref failed");
    expect(cleanup.error?.detail).toBe("fatal: bad");
    expect(cleanup.rows).toEqual([]);
    expect(cleanup.loading).toBe(false);
  });

  it("fetches every remote with prune, then lists again", async () => {
    const calls = await open();
    const cleanup = useCleanupStore();
    await cleanup.open();
    await cleanup.fetchAndPrune();
    await settled();
    expect(of(calls, "fetch").map((call) => [call.args["remote"], call.args["prune"]])).toEqual([
      [null, true],
    ]);
    expect(of(calls, "cleanup_candidates")).toHaveLength(2);
    expect(cleanup.fetching).toBe(false);
  });

  it("deletes the ticked branches with their worktrees, as listed, and reads them again", async () => {
    const calls = await open();
    const cleanup = useCleanupStore();
    await cleanup.open();
    const refsBefore = of(calls, "list_refs").length;
    const worktreesBefore = of(calls, "list_worktrees").length;
    expect(await cleanup.confirm()).toBe(true);
    await settled();
    expect(cleanup.isOpen).toBe(false);
    expect(of(calls, "delete_branches").map((call) => call.args["branches"])).toEqual([
      [
        { name: "claude/fix-auth", tip: fakeCommit(4).hash, worktree: "/wt/claude-auth" },
        { name: "feature/tiles", tip: fakeCommit(2).hash, worktree: null },
      ],
    ]);
    expect(of(calls, "list_refs").length).toBeGreaterThan(refsBefore);
    expect(of(calls, "list_worktrees").length).toBeGreaterThan(worktreesBefore);
    const repo = useRepoStore();
    expect(repo.refs.map((entry) => entry.name)).not.toContain("feature/tiles");
    expect(repo.worktrees.map((worktree) => worktree.path)).not.toContain("/wt/claude-auth");
    // The commands are the only way back to the deleted branches: the toast stays.
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      kind: "success",
      key: "cleanup.deletedWithWorktree",
      params: { n: 2, m: 1 },
      sticky: true,
      actionKey: "cleanup.showCommands",
      output: [
        `git branch claude/fix-auth ${fakeCommit(4).hash}`,
        `git branch feature/tiles ${fakeCommit(2).hash}`,
      ].join("\n"),
    });
  });

  it("says a branch that moved since the listing stayed, with nothing more to show", async () => {
    await open({
      cleanupKept: { "feature/tiles": { reason: "moved", message: null } },
    });
    const cleanup = useCleanupStore();
    await cleanup.open();
    await cleanup.confirm();
    await settled();
    const kept = useToastsStore().toasts.at(-1);
    expect(kept).toMatchObject({
      kind: "info",
      key: "cleanup.kept.moved",
      params: { n: 1, names: "feature/tiles" },
    });
    expect(kept?.output ?? "").toBe("");
  });

  it("names a branch that stayed and why, git's words one click away", async () => {
    await open({
      cleanupKept: {
        "claude/fix-auth": {
          reason: "worktree",
          message: "fatal: '/wt/claude-auth' contains modified or untracked files",
        },
      },
    });
    const cleanup = useCleanupStore();
    await cleanup.open();
    await cleanup.confirm();
    await settled();
    const [deleted, kept] = useToastsStore().toasts;
    expect(deleted).toMatchObject({
      kind: "success",
      key: "cleanup.deleted",
      params: { n: 1, m: 0 },
    });
    expect(kept).toMatchObject({
      kind: "info",
      key: "cleanup.kept.worktree",
      params: { n: 1, names: "claude/fix-auth" },
      output: "fatal: '/wt/claude-auth' contains modified or untracked files",
    });
    expect(useRepoStore().worktrees.map((worktree) => worktree.path)).toContain("/wt/claude-auth");
  });

  it("says why the branches that stayed did, one toast for each reason", async () => {
    await open({
      cleanupKept: {
        "claude/fix-auth": { reason: "failed", message: "error: cannot lock ref" },
        "feature/tiles": { reason: "failed", message: "error: unable to write" },
        "spike/maplibre": { reason: "stopped", message: null },
      },
    });
    const cleanup = useCleanupStore();
    await cleanup.open();
    cleanup.toggle("spike/maplibre");
    await cleanup.confirm();
    await settled();
    const toasts = useToastsStore().toasts;
    expect(toasts.map((toast) => [toast.key, toast.params])).toEqual([
      ["cleanup.kept.failed", { n: 2, names: "claude/fix-auth, feature/tiles" }],
      ["cleanup.kept.stopped", { n: 1, names: "spike/maplibre" }],
    ]);
    expect(toasts[0]?.output).toBe(
      ["claude/fix-auth: error: cannot lock ref", "feature/tiles: error: unable to write"].join(
        "\n",
      ),
    );
  });

  it("names three branches and counts the rest", async () => {
    const many = ["a", "b", "c", "d", "e"];
    await open({
      refs: [local("main", 0, "/r"), ...many.map((name) => local(name, 2))],
      cleanup: { main: "main", candidates: many.map((name) => candidate(name, 2, "merged")) },
      cleanupKept: Object.fromEntries(
        many.map((name) => [name, { reason: "moved" as const, message: null }]),
      ),
    });
    const cleanup = useCleanupStore();
    await cleanup.open();
    await cleanup.confirm();
    await settled();
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      key: "cleanup.kept.moved",
      params: { n: 5, names: "a, b, c +2" },
    });
  });

  it("counts a worktree that went though its branch stayed", async () => {
    await open({
      cleanupKept: {
        "claude/fix-auth": { reason: "moved", message: null, worktreeRemoved: true },
      },
    });
    const cleanup = useCleanupStore();
    await cleanup.open();
    await cleanup.confirm();
    await settled();
    const [done, kept] = useToastsStore().toasts;
    expect(done).toMatchObject({
      key: "cleanup.deletedWithWorktree",
      params: { n: 1, m: 1 },
      output: `git branch feature/tiles ${fakeCommit(2).hash}`,
    });
    expect(kept).toMatchObject({ key: "cleanup.kept.moved", params: { n: 1 } });
    expect(useRepoStore().worktrees.map((worktree) => worktree.path)).not.toContain(
      "/wt/claude-auth",
    );
  });

  it("says a worktree went when no branch did", async () => {
    await open({
      cleanupKept: {
        "claude/fix-auth": { reason: "failed", message: "error: lock", worktreeRemoved: true },
        "feature/tiles": { reason: "moved", message: null },
      },
    });
    const cleanup = useCleanupStore();
    await cleanup.open();
    await cleanup.confirm();
    await settled();
    const [done] = useToastsStore().toasts;
    expect(done).toMatchObject({
      kind: "success",
      key: "cleanup.removedWorktrees",
      params: { n: 1 },
    });
    expect(done?.output ?? "").toBe("");
    expect(done?.actionKey).toBeUndefined();
  });

  it("toasts a deletion that failed whole, and reads the refs again", async () => {
    const calls = await open({
      cleanupErrors: {
        delete: { code: "op.timeout", message: "operation timed out", detail: "after 600 s" },
      },
    });
    const cleanup = useCleanupStore();
    await cleanup.open();
    const refsBefore = of(calls, "list_refs").length;
    expect(await cleanup.confirm()).toBe(false);
    await settled();
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      kind: "error",
      key: "cleanup.failed",
      params: { message: "operation timed out" },
      output: "after 600 s",
    });
    expect(of(calls, "list_refs").length).toBeGreaterThan(refsBefore);
  });

  it("runs the deletion as an operation the status bar can stop", async () => {
    const gate = writeGate();
    await open({ writeGate: gate });
    const cleanup = useCleanupStore();
    await cleanup.open();
    const deleting = cleanup.confirm();
    await settled();
    expect(gate.waiting).toEqual(["delete_branches"]);
    // A stop keeps the branches not reached yet, which the toasts then name.
    expect(useOperationsStore().current).toMatchObject({
      label: "operations.cleaningUp",
      cancellable: true,
    });
    gate.release();
    await deleting;
    expect(useOperationsStore().operations).toEqual([]);
  });

  it("keeps the dialog shut while a deletion runs", async () => {
    const gate = writeGate();
    await open({ writeGate: gate });
    const cleanup = useCleanupStore();
    await cleanup.open();
    const deleting = cleanup.confirm();
    await settled();
    expect(gate.waiting).toEqual(["delete_branches"]);
    await cleanup.open();
    expect(cleanup.isOpen).toBe(false);
    expect(useToastsStore().toasts.at(-1)?.key).toBe("cleanup.busy");
    gate.release();
    await deleting;
  });

  it("confirms nothing when nothing is ticked", async () => {
    const calls = await open();
    const cleanup = useCleanupStore();
    await cleanup.open();
    cleanup.toggle("claude/fix-auth");
    cleanup.toggle("feature/tiles");
    expect(await cleanup.confirm()).toBe(false);
    expect(of(calls, "delete_branches")).toEqual([]);
    expect(cleanup.isOpen).toBe(true);
  });

  it("quotes a name the shell would read in the commands that bring it back", async () => {
    await open({
      refs: [local("main", 0, "/r"), local("fix;echo", 2)],
      cleanup: { main: "main", candidates: [candidate("fix;echo", 2, "merged")] },
    });
    const cleanup = useCleanupStore();
    await cleanup.open();
    await cleanup.confirm();
    await settled();
    expect(useToastsStore().toasts.at(-1)?.output).toBe(
      `git branch 'fix;echo' ${fakeCommit(2).hash}`,
    );
  });
});
