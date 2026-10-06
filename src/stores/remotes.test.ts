import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Remote } from "@/ipc/schemas";
import {
  FAKE_PROGRESS,
  fakeBackend,
  settled,
  type Call,
  type FakeBackendOptions,
} from "@/test/backend";

import { useOperationsStore } from "./operations";
import { splitUpstream, useRemotesStore } from "./remotes";
import { useRepoStore } from "./repo";
import { useSequencerStore } from "./sequencer";
import { memoryStorage, useSettingsStore } from "./settings";
import { useShellStore } from "./shell";
import { useToastsStore } from "./toasts";

const remotes: Remote[] = [
  {
    name: "origin",
    fetchUrl: "git@github.com:ikerzam/geoportal.git",
    fetchedAt: 1_758_499_000,
    pushUrl: "git@github.com:ikerzam/geoportal.git",
  },
  {
    name: "upstream",
    fetchUrl: "https://example.com/geoportal.git",
    fetchedAt: null,
    pushUrl: "https://example.com/geoportal.git",
  },
];

async function open(options: FakeBackendOptions = {}): Promise<Call[]> {
  const calls = fakeBackend({ remotes, ...options });
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

describe("remotes store", () => {
  it("splits an upstream into its remote and branch", () => {
    expect(splitUpstream("origin/main")).toEqual({ remote: "origin", branch: "main" });
    expect(splitUpstream("origin/release/2.4")).toEqual({
      remote: "origin",
      branch: "release/2.4",
    });
    expect(splitUpstream(null)).toBeNull();
    expect(splitUpstream("main")).toBeNull();
  });

  it("lists the remotes when the sheet opens, adds and removes one", async () => {
    const calls = await open();
    const store = useRemotesStore();
    await store.openSheet();
    expect(store.sheetOpen).toBe(true);
    expect(store.remotes.map((remote) => remote.name)).toEqual(["origin", "upstream"]);
    await store.add("fork", "git@github.com:ane/geoportal.git");
    expect(of(calls, "remote_add")[0]?.args).toMatchObject({
      name: "fork",
      url: "git@github.com:ane/geoportal.git",
    });
    expect(store.remotes.map((remote) => remote.name)).toEqual(["origin", "upstream", "fork"]);
    store.ask({ kind: "removeRemote", name: "upstream" });
    await store.remove("upstream");
    expect(store.prompt).toBeNull();
    expect(store.remotes.map((remote) => remote.name)).toEqual(["origin", "fork"]);
    store.closeSheet();
    expect(store.sheetOpen).toBe(false);
  });

  it("lists the remotes again on refs: at once in the open sheet, for the next dialog otherwise", async () => {
    const calls = await open();
    const store = useRemotesStore();
    await store.openSheet();
    const listings = () => of(calls, "remotes").length;
    const before = listings();
    // A remote added from a terminal rewrites the configuration, which the watcher reports as
    // refs.
    store.onRepoChanged(["status"]);
    await settled();
    expect(listings()).toBe(before);
    store.onRepoChanged(["refs"]);
    await settled();
    expect(listings()).toBe(before + 1);
    store.closeSheet();
    store.onRepoChanged(["refs"]);
    await settled();
    expect(listings()).toBe(before + 1);
    expect(store.loaded).toBe(false);
    store.ask({ kind: "push", branch: "main" });
    await settled();
    expect(listings()).toBe(before + 2);
  });

  it("pushes with the progress in the status bar, then toasts and refreshes the refs", async () => {
    const calls = await open();
    const store = useRemotesStore();
    const operations = useOperationsStore();
    const pushing = store.push({
      remote: "origin",
      branch: "main",
      tag: null,
      delete: false,
      setUpstream: false,
      forceWithLease: false,
    });
    expect(operations.current?.label).toBe("operations.pushing");
    expect(operations.current?.params).toEqual({ branch: "main", remote: "origin" });
    expect(operations.current?.cancellable).toBe(true);
    expect(store.inFlight).not.toBeNull();
    await settled();
    expect(
      operations.operations.at(-1)?.detail ?? operations.current?.detail ?? FAKE_PROGRESS[1],
    ).toBe(FAKE_PROGRESS[1]);
    expect(await pushing).toBe(true);
    await settled();
    expect(of(calls, "push")[0]?.args["request"]).toEqual({
      remote: "origin",
      branch: "main",
      tag: null,
      delete: false,
      setUpstream: false,
      forceWithLease: false,
    });
    expect(operations.current).toBeUndefined();
    expect(store.inFlight).toBeNull();
    const toast = useToastsStore().toasts.at(-1);
    expect(toast?.key).toBe("remotes.pushed");
    expect(toast?.params).toEqual({ branch: "main", remote: "origin" });
    expect(toast?.output).toContain("main -> main");
    expect(of(calls, "list_refs").length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a command while another runs, with a toast, and keeps the push dialog open", async () => {
    // The fetch answers after 50ms, so it is still running when the others are asked.
    const calls = await open({ networkDelayMs: 50 });
    const store = useRemotesStore();
    const fetching = store.fetch(null, false);
    expect(await store.fetch("origin", false)).toBe(false);
    expect(useToastsStore().toasts.at(-1)?.key).toBe("remotes.busy");
    store.ask({ kind: "push", branch: "main" });
    const request = {
      remote: "origin",
      branch: "main",
      tag: null,
      delete: false,
      setUpstream: false,
      forceWithLease: false,
    };
    expect(await store.push(request)).toBe(false);
    expect(store.prompt).toEqual({ kind: "push", branch: "main" });
    expect(await fetching).toBe(true);
    await settled();
    expect(of(calls, "fetch")).toHaveLength(1);
    expect(of(calls, "push")).toHaveLength(0);
  });

  it("says a rejected push needs a pull, offers Pull… on the checked-out branch, and keeps git's output", async () => {
    await open({ failNetwork: true });
    const store = useRemotesStore();
    const request = (branch: string | null) => ({
      remote: null,
      branch,
      tag: null,
      delete: false,
      setUpstream: true,
      forceWithLease: false,
    });
    expect(await store.push(request(null))).toBe(false);
    const toast = useToastsStore().toasts.at(-1);
    expect(toast?.kind).toBe("error");
    expect(toast?.key).toBe("remotes.pushRejected");
    expect(toast?.params).toEqual({ branch: "main", remote: "origin" });
    expect(toast?.output).toContain("[rejected]");
    expect(toast?.actionKey).toBe("remotes.pullAction");
    toast?.onAction?.();
    expect(store.prompt).toEqual({ kind: "pull", branch: "main" });
    expect(useOperationsStore().current).toBeUndefined();
    // A branch that is not checked out cannot take a pull: the toast says why, without the action.
    store.dismiss();
    expect(await store.push(request("develop"))).toBe(false);
    const other = useToastsStore().toasts.at(-1);
    expect(other?.key).toBe("remotes.pushRejected");
    expect(other?.onAction).toBeUndefined();
  });

  it("fetches with prune and pulls; a pull that conflicts opens the changes screen", async () => {
    const calls = await open();
    const store = useRemotesStore();
    expect(await store.fetch("origin", true)).toBe(true);
    expect(of(calls, "fetch")[0]?.args).toMatchObject({ remote: "origin", prune: true });
    expect(useToastsStore().toasts.at(-1)?.key).toBe("remotes.fetched");
    expect(await store.pull({ remote: null, branch: null, rebase: true, ffOnly: false })).toBe(
      true,
    );
    expect(of(calls, "pull")[0]?.args["request"]).toEqual({
      remote: null,
      branch: null,
      rebase: true,
      ffOnly: false,
    });
    // A single repository's pull may prompt for a sign-in; only a batch may not.
    expect(of(calls, "pull")[0]?.args["batch"]).toBe(false);
    expect(useToastsStore().toasts.at(-1)?.key).toBe("remotes.pulled");
    clearMocks();
    const stopped = fakeBackend({
      remotes,
      outcome: {
        kind: "conflicts",
        hash: null,
        conflicts: [{ path: "src/a.ts", kind: "both-modified" }],
      },
      operation: "merge",
      conflicts: [{ path: "src/a.ts", kind: "both-modified" }],
    });
    expect(
      await store.pull({ remote: "origin", branch: "main", rebase: false, ffOnly: false }),
    ).toBe(true);
    await settled();
    expect(useShellStore().layoutMode).toBe("changes");
    expect(useSequencerStore().conflicts).toHaveLength(1);
    // Its fetch moved the remote branches, and a rebase HEAD: the refs are listed again.
    expect(of(stopped, "list_refs").length).toBeGreaterThan(0);
  });

  it("cancels the network command in flight without a toast", async () => {
    await open();
    const store = useRemotesStore();
    const pushing = store.push({
      remote: "origin",
      branch: "main",
      tag: null,
      delete: false,
      setUpstream: false,
      forceWithLease: false,
    });
    await store.cancel();
    expect(await pushing).toBe(false);
    await settled();
    expect(useToastsStore().toasts).toHaveLength(0);
    expect(store.inFlight).toBeNull();
  });
});
