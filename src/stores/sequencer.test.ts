import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Conflict } from "@/ipc/schemas";
import {
  FAKE_SIDES,
  fakeBackend,
  settled,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";
import { repoChange } from "@/test/changes";

import { useRepoStore } from "./repo";
import { useSequencerStore } from "./sequencer";
import { memoryStorage, useSettingsStore } from "./settings";
import { useToastsStore } from "./toasts";

const conflicts: Conflict[] = [
  { path: "src/a.ts", kind: "both-modified" },
  { path: "docs/b.md", kind: "deleted-by-them" },
];

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

describe("sequencer store", () => {
  it("reads the operation and its conflicts, and knows what can continue or skip", async () => {
    await open({ operation: "rebase", conflicts });
    const sequencer = useSequencerStore();
    await sequencer.load();
    expect(sequencer.operation).toBe("rebase");
    expect(sequencer.conflicts).toEqual(conflicts);
    expect(sequencer.inProgress).toBe(true);
    expect(sequencer.conflictCount).toBe(2);
    expect(sequencer.canContinue).toBe(false);
    expect(sequencer.canSkip).toBe(true);
  });

  it("is idle on a clean repository and follows the watcher's kinds", async () => {
    const calls = await open();
    const sequencer = useSequencerStore();
    await sequencer.load();
    expect(sequencer.inProgress).toBe(false);
    expect(sequencer.loaded).toBe(true);
    const before = of(calls, "operation_state").length;
    sequencer.onRepoChanged(repoChange({ kinds: ["worktrees"] }));
    // The working tree alone, or an index change that moved no unmerged entry: nothing.
    sequencer.onRepoChanged(repoChange({ kinds: ["status"], paths: ["src/a.ts"] }));
    sequencer.onRepoChanged(repoChange({ kinds: ["index"], indexPaths: ["src/a.ts"] }));
    await settled();
    expect(of(calls, "operation_state")).toHaveLength(before);
    sequencer.onRepoChanged(repoChange({ kinds: ["refs"] }));
    await settled();
    expect(of(calls, "operation_state")).toHaveLength(before + 1);
    sequencer.onRepoChanged(
      repoChange({ kinds: ["index"], indexPaths: ["src/a.ts"], conflictsChanged: true }),
    );
    await settled();
    expect(of(calls, "operation_state")).toHaveLength(before + 2);
  });

  it("marks paths resolved and reloads; continue then moves the graph on the new HEAD", async () => {
    const calls = await open({ operation: "merge", conflicts });
    const sequencer = useSequencerStore();
    await sequencer.load();
    expect(await sequencer.markResolved(["src/a.ts"])).toBe(true);
    expect(of(calls, "mark_resolved")[0]?.args["paths"]).toEqual(["src/a.ts"]);
    expect(of(calls, "conflicts").length).toBeGreaterThanOrEqual(2);
    clearMocks();
    const clean = fakeBackend();
    const walks = of(clean, "walk_commits").length;
    const outcome = await sequencer.act("continue");
    await settled();
    expect(outcome?.kind).toBe("done");
    expect(of(clean, "sequencer")[0]?.args["action"]).toBe("continue");
    expect(sequencer.operation).toBe("none");
    expect(sequencer.inProgress).toBe(false);
    expect(of(clean, "walk_commits").length).toBe(walks + 1);
  });

  it("keeps the state and reports git's words when continue is refused", async () => {
    await open({ operation: "merge", conflicts });
    const sequencer = useSequencerStore();
    await sequencer.load();
    const { mockIPC } = await import("@tauri-apps/api/mocks");
    mockIPC((cmd) => {
      if (cmd === "sequencer") {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
        return Promise.reject({
          code: "git.cli_failed",
          message: "git merge --continue failed",
          detail: "error: Committing is not possible because you have unmerged files.",
        });
      }
      if (cmd === "operation_state") return "merge";
      if (cmd === "conflicts") return conflicts;
      return null;
    });
    expect(await sequencer.act("continue")).toBeNull();
    await settled();
    expect(sequencer.error?.detail).toContain("unmerged files");
    expect(sequencer.operation).toBe("merge");
    expect(sequencer.busy).toBe(false);
    sequencer.dismissError();
    expect(sequencer.error).toBeNull();
  });
});

describe("taking a side", () => {
  /** The toast that offers to undo a side taken. */
  function undoToast() {
    return useToastsStore().toasts.find((toast) => toast.actionKey === "sequencer.side.undo");
  }

  it("reads the operation's sides with its state, and none without an operation", async () => {
    await open({ operation: "merge", conflicts });
    const sequencer = useSequencerStore();
    await sequencer.load();
    expect(sequencer.sides).toEqual(FAKE_SIDES);
    clearMocks();
    fakeBackend();
    await sequencer.load();
    expect(sequencer.sides).toBeNull();
  });

  it("keeps the conflicts when the sides cannot be named, without offering a side", async () => {
    await open({
      operation: "cherry-pick",
      conflicts,
      sideErrors: { sides: { code: "internal", message: "HEAD names no commit" } },
    });
    const sequencer = useSequencerStore();
    await sequencer.load();
    expect(sequencer.conflicts).toEqual(conflicts);
    expect(sequencer.sides).toBeNull();
    expect(sequencer.error).toBeNull();
    sequencer.askTakeSide("src/a.ts", "ours");
    expect(sequencer.takePrompt).toBeNull();
  });

  it("asks first, then takes the side, lists the conflicts again and offers Undo", async () => {
    const calls = await open({ operation: "merge", conflicts });
    const sequencer = useSequencerStore();
    await sequencer.load();
    sequencer.askTakeSide("src/a.ts", "theirs");
    expect(sequencer.takePrompt).toEqual({ path: "src/a.ts", side: "theirs" });
    expect(of(calls, "take_side")).toHaveLength(0);
    expect(await sequencer.takeSide()).toBe(true);
    expect(sequencer.takePrompt).toBeNull();
    expect(of(calls, "take_side")[0]?.args).toMatchObject({ paths: ["src/a.ts"], side: "theirs" });
    expect(sequencer.conflicts.map((conflict) => conflict.path)).toEqual(["docs/b.md"]);
    const toast = undoToast();
    expect(toast?.kind).toBe("success");
    expect(toast?.key).toBe("sequencer.side.used.ref");
    expect(toast?.params).toMatchObject({ file: "a.ts", name: "develop" });
    // Undo: the conflict comes back into the list.
    toast?.onAction?.();
    await settled();
    expect(of(calls, "restore_conflicts")[0]?.args["paths"]).toEqual(["src/a.ts"]);
    expect(sequencer.conflicts.map((conflict) => conflict.path)).toEqual(["docs/b.md", "src/a.ts"]);
  });

  it("cancels without writing, and asks nothing without sides or for a path not conflicted", async () => {
    const calls = await open({ operation: "merge", conflicts });
    const sequencer = useSequencerStore();
    await sequencer.load();
    sequencer.askTakeSide("src/a.ts", "ours");
    sequencer.dismissTakeSide();
    expect(sequencer.takePrompt).toBeNull();
    expect(await sequencer.takeSide()).toBe(false);
    sequencer.askTakeSide("src/elsewhere.ts", "ours");
    expect(sequencer.takePrompt).toBeNull();
    clearMocks();
    fakeBackend({ operation: "merge", conflicts, sides: null });
    await sequencer.load();
    sequencer.askTakeSide("src/a.ts", "ours");
    expect(sequencer.takePrompt).toBeNull();
    expect(of(calls, "take_side")).toHaveLength(0);
  });

  it("says a refused side or Undo in a toast that names the file", async () => {
    await open({
      operation: "merge",
      conflicts,
      sideErrors: {
        take: { code: "conflict.submodule", message: "src/a.ts is a submodule" },
        restore: {
          code: "conflict.gone",
          message: "the conflict of src/a.ts cannot be brought back",
        },
      },
    });
    const sequencer = useSequencerStore();
    await sequencer.load();
    sequencer.askTakeSide("src/a.ts", "ours");
    expect(await sequencer.takeSide()).toBe(false);
    const toasts = useToastsStore();
    expect(toasts.toasts.at(-1)).toMatchObject({
      kind: "error",
      key: "errors.submoduleConflict",
      params: { path: "src/a.ts" },
    });
    expect(sequencer.conflicts).toHaveLength(2);
    expect(sequencer.busy).toBe(false);
    expect(await sequencer.restoreConflict("/r", "src/a.ts")).toBe(false);
    expect(toasts.toasts.at(-1)).toMatchObject({
      kind: "error",
      key: "errors.conflictGone",
      params: { path: "src/a.ts" },
    });
  });

  it("names the action and the file when git refuses with words of its own", async () => {
    const refused = { code: "git.cli_failed", message: "git checkout failed", detail: "error: x" };
    await open({ operation: "merge", conflicts, sideErrors: { take: refused, restore: refused } });
    const sequencer = useSequencerStore();
    await sequencer.load();
    sequencer.askTakeSide("src/a.ts", "theirs");
    await sequencer.takeSide();
    const toasts = useToastsStore();
    expect(toasts.toasts.at(-1)).toMatchObject({
      key: "sequencer.side.takeFailed",
      params: { path: "src/a.ts" },
      output: "error: x",
    });
    await sequencer.restoreConflict("/r", "src/a.ts");
    expect(toasts.toasts.at(-1)).toMatchObject({ key: "sequencer.side.undoFailed" });
    // A lock is still said as such.
    const locked = { ...refused, detail: "fatal: Unable to create '/r/.git/index.lock'" };
    clearMocks();
    fakeBackend({ operation: "merge", conflicts, sideErrors: { take: locked } });
    sequencer.askTakeSide("src/a.ts", "theirs");
    await sequencer.takeSide();
    expect(toasts.toasts.at(-1)).toMatchObject({ key: "errors.indexLock" });
  });

  it("closes the Undo toast when the sequencer runs, and keeps one at a time", async () => {
    await open({ operation: "merge", conflicts });
    const sequencer = useSequencerStore();
    await sequencer.load();
    sequencer.askTakeSide("src/a.ts", "ours");
    await sequencer.takeSide();
    sequencer.askTakeSide("docs/b.md", "theirs");
    await sequencer.takeSide();
    const offered = useToastsStore().toasts.filter(
      (toast) => toast.actionKey === "sequencer.side.undo",
    );
    expect(offered).toHaveLength(1);
    expect(offered[0]?.params).toMatchObject({ file: "b.md" });
    await sequencer.act("continue");
    expect(undoToast()).toBeUndefined();
  });
});
