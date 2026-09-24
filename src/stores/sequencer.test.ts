import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Conflict } from "@/ipc/schemas";
import { fakeBackend, settled, type Call, type FakeBackendOptions } from "@/test/backend";
import { repoChange } from "@/test/changes";

import { useRepoStore } from "./repo";
import { useSequencerStore } from "./sequencer";
import { memoryStorage, useSettingsStore } from "./settings";

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
