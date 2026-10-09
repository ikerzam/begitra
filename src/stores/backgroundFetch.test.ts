import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeBackend, settled, type Call, type FakeBackendOptions } from "@/test/backend";
import { entryOf, projectOf, summaryOf, worktreeOf } from "@/test/entries";

import { TICK_MS, useBackgroundFetchStore } from "./backgroundFetch";
import { useBulkStore } from "./bulk";
import { useFolderStore } from "./folder";
import { useIndexStore } from "./index";
import { useOperationsStore } from "./operations";
import { useProjectsStore } from "./projects";
import { useRemotesStore } from "./remotes";
import { memoryStorage, useSettingsStore } from "./settings";
import { useToastsStore } from "./toasts";

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const minutesAgo = (minutes: number) => Math.floor((NOW - minutes * 60_000) / 1000);

const GEO = "/home/iker/code/geo";
const api = entryOf(`${GEO}/api`, { summary: summaryOf({ fetchedAt: minutesAgo(20) }) });
const web = entryOf(`${GEO}/web`, { summary: summaryOf({ fetchedAt: minutesAgo(5) }) });
const webAuth = worktreeOf("/home/iker/wt/web-claude-auth", web.path, {
  summary: summaryOf({ fetchedAt: minutesAgo(30) }),
});
const infra = entryOf(`${GEO}/infra`, { summary: summaryOf({ fetchedAt: null }) });
const tiles = entryOf("/home/iker/code/tiles", { summary: summaryOf({ fetchedAt: null }) });
const members = [api, web, webAuth, infra];

const signIn = {
  code: "git.cli_failed",
  message: "git fetch failed",
  detail: "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
};

const fetched = (calls: Call[]) =>
  calls.filter((call) => call.cmd === "fetch").map((call) => call.args["repo"]);

let hidden = false;
let stop: (() => void) | undefined;

async function openProject(options: FakeBackendOptions = {}, interval: 15 | null = 15) {
  const calls = fakeBackend({
    repositories: [...members, tiles],
    projects: [
      projectOf(
        1,
        "Geoportal",
        members.map((entry) => entry.path),
      ),
      projectOf(2, "Tiles", [tiles.path]),
    ],
    summaries: Object.fromEntries([...members, tiles].map((entry) => [entry.path, entry.summary])),
    rootIsPath: true,
    ...options,
  });
  if (interval) useBackgroundFetchStore().setIntervalOf(1, interval);
  const projects = useProjectsStore();
  await Promise.all([projects.load(), useIndexStore().load()]);
  await projects.open(1);
  await settled();
  return calls;
}

/** Lets the fetches started end, with what they read again after them. */
async function drained(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await settled();
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "linux");
});

afterEach(async () => {
  stop?.();
  stop = undefined;
  // A fetch still on its way would end inside the next test, with this test's stores.
  const background = useBackgroundFetchStore();
  for (let i = 0; i < 100 && background.runningCount > 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await settled();
  useFolderStore().hide();
  clearMocks();
  vi.useRealTimers();
});

describe("fetch in the background", () => {
  it("fetches the open project's repositories that are due, two at a time, saying nothing", async () => {
    const calls = await openProject();
    stop = useBackgroundFetchStore().begin();
    await settled();
    // `web` fetched 5 minutes ago (its worktree's own time is older); `api` and `infra` are due.
    expect(fetched(calls)).toEqual([api.path, infra.path]);
    const fetches = calls.filter((call) => call.cmd === "fetch");
    expect(fetches.every((call) => call.args["batch"] === true)).toBe(true);
    await drained();
    expect(useToastsStore().toasts).toHaveLength(0);
    expect(useOperationsStore().current).toBeUndefined();
    // Ten minutes on, `web` is due, and its worktree rides on its fetch.
    vi.advanceTimersByTime(10 * 60_000);
    await drained();
    expect(fetched(calls)).toEqual([api.path, infra.path, web.path]);
    // A whole interval after their tries, `api` and `infra` again.
    vi.advanceTimersByTime(5 * 60_000);
    await drained();
    expect(fetched(calls).slice(3)).toEqual([api.path, infra.path]);
  });

  it("runs two fetches at a time, the next one as soon as one ends", async () => {
    const three = ["one", "two", "three"].map((name) =>
      entryOf(`${GEO}/${name}`, { summary: summaryOf({ fetchedAt: null }) }),
    );
    const calls = fakeBackend({
      repositories: three,
      projects: [
        projectOf(
          1,
          "Three",
          three.map((entry) => entry.path),
        ),
      ],
      summaries: Object.fromEntries(three.map((entry) => [entry.path, entry.summary])),
      rootIsPath: true,
      networkDelayMs: 30,
    });
    useBackgroundFetchStore().setIntervalOf(1, 15);
    const projects = useProjectsStore();
    await Promise.all([projects.load(), useIndexStore().load()]);
    await projects.open(1);
    await settled();
    stop = useBackgroundFetchStore().begin();
    await settled();
    expect(fetched(calls)).toEqual([three[0]?.path, three[1]?.path]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await drained();
    expect(fetched(calls)).toEqual(three.map((entry) => entry.path));
  });

  it("fetches nothing by hand only, while hidden, offline, or while a fetch by hand runs", async () => {
    const calls = await openProject({}, null);
    stop = useBackgroundFetchStore().begin();
    vi.advanceTimersByTime(TICK_MS);
    await settled();
    expect(fetched(calls)).toEqual([]);
    // Hidden: nothing until the window shows again, then the due ones at once.
    hidden = true;
    useBackgroundFetchStore().setIntervalOf(1, 15);
    vi.advanceTimersByTime(TICK_MS);
    await settled();
    expect(fetched(calls)).toEqual([]);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await settled();
    expect(fetched(calls)).toEqual([api.path, infra.path]);
  });

  it("starts nothing while a fetch by hand runs, and the due ones once it ended", async () => {
    const calls = await openProject({ networkDelayMs: 40 }, null);
    stop = useBackgroundFetchStore().begin();
    const byHand = useRemotesStore().fetch(null, false);
    useBackgroundFetchStore().setIntervalOf(1, 15);
    await settled();
    expect(fetched(calls)).toEqual([api.path]);
    expect(await byHand).toBe(true);
    vi.advanceTimersByTime(TICK_MS);
    await settled();
    expect(fetched(calls).slice(1)).toEqual([api.path, infra.path]);
  });

  it("waits while the system is offline, and tries an unreachable repository once back", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const calls = await openProject();
    stop = useBackgroundFetchStore().begin();
    await settled();
    expect(fetched(calls)).toEqual([]);
    online.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    await settled();
    expect(fetched(calls)).toEqual([api.path, infra.path]);
    online.mockRestore();
  });

  it("stops a repository that asks for a sign-in, with one toast, until a fetch by hand works", async () => {
    const calls = await openProject({ networkErrors: { [infra.path]: signIn } });
    const background = useBackgroundFetchStore();
    stop = background.begin();
    await drained();
    expect(background.stoppedFor(infra.path)).toBe(true);
    const toasts = useToastsStore().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ kind: "info", key: "backgroundFetch.signIn" });
    expect(toasts[0]?.params).toMatchObject({ name: "infra" });
    vi.advanceTimersByTime(30 * 60_000);
    await drained();
    expect(fetched(calls).filter((path) => path === infra.path)).toHaveLength(1);
    expect(useToastsStore().toasts).toHaveLength(1);
    background.resume(infra.path);
    vi.advanceTimersByTime(TICK_MS);
    await drained();
    expect(fetched(calls).filter((path) => path === infra.path)).toHaveLength(2);
  });

  it("lets a pull wait for the fetch in the background on its repository", async () => {
    const calls = await openProject({ networkDelayMs: 40 });
    stop = useBackgroundFetchStore().begin();
    await settled();
    expect(fetched(calls)).toEqual([api.path, infra.path]);
    const remotes = useRemotesStore();
    const pulling = remotes.pull({
      remote: null,
      branch: null,
      rebase: false,
      ffOnly: true,
      autostash: false,
    });
    await Promise.resolve();
    const waiting = useOperationsStore().current;
    expect(waiting?.label).toBe("operations.waitingForBackgroundFetch");
    // Escape's hint names the pull it cancels with the fetch.
    expect(waiting?.cancels).toBe("pull");
    expect(calls.filter((call) => call.cmd === "pull")).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await pulling).toBe(true);
    expect(calls.filter((call) => call.cmd === "pull")).toHaveLength(1);
  });

  it("cancels the fetch in the background with the command that waits for it", async () => {
    const calls = await openProject({ networkDelayMs: 200 });
    stop = useBackgroundFetchStore().begin();
    await settled();
    const remotes = useRemotesStore();
    const pulling = remotes.pull({
      remote: null,
      branch: null,
      rebase: false,
      ffOnly: true,
      autostash: false,
    });
    await Promise.resolve();
    await remotes.cancel();
    expect(await pulling).toBe(false);
    expect(calls.filter((call) => call.cmd === "pull")).toHaveLength(0);
    expect(calls.some((call) => call.cmd === "cancel_operation")).toBe(true);
    await settled();
    expect(useToastsStore().toasts).toHaveLength(0);
    expect(remotes.inFlight).toBeNull();
  });

  it("lets a project's bulk turn wait for the fetch in the background, the row queued", async () => {
    const calls = await openProject({ networkDelayMs: 40 });
    stop = useBackgroundFetchStore().begin();
    await settled();
    useFolderStore().show();
    await settled();
    const bulk = useBulkStore();
    bulk.ask("fetch");
    await settled();
    expect(bulk.states.get(api.path)).toEqual({ state: "queued" });
    expect(fetched(calls).filter((path) => path === api.path)).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await drained();
    expect(fetched(calls).filter((path) => path === api.path)).toHaveLength(2);
  });

  it("lets Stop end a bulk member's wait at once, the fetch in the background going on", async () => {
    const calls = await openProject({ networkDelayMs: 200 });
    stop = useBackgroundFetchStore().begin();
    await settled();
    useFolderStore().show();
    await settled();
    const bulk = useBulkStore();
    bulk.ask("fetch");
    await settled();
    expect(bulk.states.get(api.path)).toEqual({ state: "queued" });
    await bulk.stop();
    await drained();
    expect(bulk.running).toBe(false);
    expect(bulk.states.get(api.path)).toEqual({ state: "stopped" });
    // Stop cancels the bulk's own fetches, not the ones in the background.
    expect(useBackgroundFetchStore().runningCount).toBeGreaterThan(0);
    const cancelled = calls.filter((call) => call.cmd === "cancel_operation");
    expect(cancelled.some((call) => String(call.args["opId"]).startsWith("background"))).toBe(
      false,
    );
  });

  it("starts nothing for another project opened, and forgets a deleted project's interval", async () => {
    const calls = await openProject({ networkDelayMs: 40 });
    const background = useBackgroundFetchStore();
    stop = background.begin();
    await settled();
    expect(fetched(calls)).toEqual([api.path, infra.path]);
    await useProjectsStore().open(2);
    await new Promise((resolve) => setTimeout(resolve, 60));
    vi.advanceTimersByTime(30 * 60_000);
    await drained();
    expect(fetched(calls)).toEqual([api.path, infra.path]);
    expect(background.intervalOf(1)).toBe(15);
    await useProjectsStore().remove(1);
    await settled();
    expect(useSettingsStore().values.backgroundFetch).toEqual({});
  });
});
