import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Ref } from "@/ipc/schemas";
import {
  fakeBackend,
  fakeCommit,
  settled,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";

import { useRepoStore } from "./repo";
import { useSequencerStore } from "./sequencer";
import { memoryStorage, useSettingsStore } from "./settings";
import { useShellStore } from "./shell";
import { stashIndex, useStashStore } from "./stash";
import { useToastsStore } from "./toasts";

function stashRef(index: number, message: string, hash: string): Ref {
  return {
    name: `stash@{${index}}`,
    fullName: "refs/stash",
    kind: "stash",
    target: hash,
    isCurrent: false,
    upstream: null,
    ahead: null,
    behind: null,
    worktree: null,
    message,
    committedAt: null,
  };
}

const refs: Ref[] = [
  {
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
  },
  stashRef(1, "On main: tiles spike", "f".repeat(40)),
  stashRef(0, "wip: worker pool before the rebase", fakeCommit(3).hash),
];

async function open(options: FakeBackendOptions = {}): Promise<Call[]> {
  const calls = fakeBackend({ refs, ...options });
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

describe("stash store", () => {
  it("lists the stashes newest first with the message and the date the history knows", async () => {
    await open();
    const stash = useStashStore();
    expect(stashIndex("stash@{12}")).toBe(12);
    expect(stashIndex("main")).toBeNull();
    expect(stash.stashes.map((row) => [row.index, row.message, row.time])).toEqual([
      [0, "wip: worker pool before the rebase", fakeCommit(3).author.time],
      [1, "On main: tiles spike", null],
    ]);
  });

  it("pushes a stash with its message and the untracked files, or says there was nothing", async () => {
    const calls = await open();
    const stash = useStashStore();
    expect(await stash.push("wip", true)).toBe(true);
    expect(of(calls, "stash_push")[0]?.args["request"]).toEqual({
      message: "wip",
      includeUntracked: true,
      paths: [],
    });
    expect(useToastsStore().toasts.at(-1)?.key).toBe("stash.pushed");
    clearMocks();
    fakeBackend({ refs, stashNothing: true });
    expect(await stash.push(null, false)).toBe(false);
    expect(useToastsStore().toasts.at(-1)?.key).toBe("stash.nothing");
  });

  it("applies, pops and drops the row's stash by its commit, the drop after its prompt", async () => {
    const calls = await open();
    const stash = useStashStore();
    stash.openSheet();
    const [newest, older] = stash.stashes;
    expect(await stash.apply(older!)).toBe(true);
    expect(of(calls, "stash_apply")[0]?.args["stash"]).toBe("f".repeat(40));
    expect(await stash.pop(newest!)).toBe(true);
    expect(of(calls, "stash_pop")[0]?.args["stash"]).toBe(fakeCommit(3).hash);
    stash.askDrop(older!);
    expect(stash.dropPrompt?.name).toBe("stash@{1}");
    expect(await stash.drop(older!)).toBe(true);
    expect(stash.dropPrompt).toBeNull();
    expect(of(calls, "stash_drop")[0]?.args["stash"]).toBe("f".repeat(40));
    expect(useToastsStore().toasts.map((toast) => toast.key)).toEqual([
      "stash.applied",
      "stash.popped",
      "stash.dropped",
    ]);
    expect(of(calls, "list_refs").length).toBeGreaterThanOrEqual(4);
  });

  it("says a stash gone outside the app is no longer in the list and lists them again", async () => {
    const calls = await open({ stashGone: true });
    const stash = useStashStore();
    stash.openSheet();
    const listings = of(calls, "list_refs").length;
    expect(await stash.drop(stash.stashes[1]!)).toBe(false);
    await settled();
    const toast = useToastsStore().toasts.at(-1);
    expect(toast?.kind).toBe("error");
    expect(toast?.key).toBe("errors.stashNotFound");
    expect(toast?.output).toBe(`stash ${"f".repeat(40)} is no longer in the stash list`);
    expect(of(calls, "list_refs").length).toBeGreaterThan(listings);
    // No success toast: nothing was dropped.
    expect(useToastsStore().toasts.map((entry) => entry.key)).toEqual(["errors.stashNotFound"]);
  });

  it("hands a conflicting pop to the sequencer on the changes screen, the sheet closed", async () => {
    await open({
      outcome: {
        kind: "conflicts",
        hash: null,
        conflicts: [{ path: "src/a.ts", kind: "both-modified" }],
      },
      conflicts: [{ path: "src/a.ts", kind: "both-modified" }],
    });
    const stash = useStashStore();
    stash.openSheet();
    expect(await stash.pop(stash.stashes[0]!)).toBe(true);
    await settled();
    expect(stash.sheetOpen).toBe(false);
    expect(useShellStore().layoutMode).toBe("changes");
    expect(useSequencerStore().conflicts).toEqual([{ path: "src/a.ts", kind: "both-modified" }]);
    expect(useToastsStore().toasts).toHaveLength(0);
  });
});
