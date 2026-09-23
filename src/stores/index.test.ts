import type { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IndexEntry, RepoSummary, ScanMessage } from "@/ipc/schemas";

import { useIndexStore } from "./index";
import { useOperationsStore } from "./operations";
import { useRepoStore } from "./repo";
import { memoryStorage, useSettingsStore } from "./settings";
import { useToastsStore } from "./toasts";

const CODE = "/home/iker/code";
const WT = "/home/iker/wt";

function summary(over: Partial<RepoSummary> = {}): RepoSummary {
  return {
    currentBranch: "main",
    detached: false,
    ahead: 0,
    behind: 0,
    lastCommitAt: 1_704_000_000,
    dirty: false,
    ...over,
  };
}

function entry(name: string, over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    path: `${CODE}/${name}`,
    name,
    kind: "main",
    parentPath: null,
    scanRoot: CODE,
    summary: summary(),
    pinned: false,
    lastOpenedAt: null,
    refreshedAt: 1_704_000_100,
    missing: false,
    ...over,
  };
}

function worktree(name: string, parent: string, over: Partial<IndexEntry> = {}): IndexEntry {
  return entry(name, {
    path: `${WT}/${name}`,
    kind: "worktree",
    parentPath: parent,
    scanRoot: WT,
    ...over,
  });
}

/** The fixture index: two mains under ~/code, one worktree of geoportal under ~/wt. */
function fixture(): IndexEntry[] {
  return [
    entry("geoportal", {
      pinned: true,
      lastOpenedAt: 1_704_070_000,
      summary: summary({ ahead: 2, dirty: true, lastCommitAt: 1_704_060_000 }),
    }),
    entry("begitra", { lastOpenedAt: 1_704_080_000, summary: summary({ currentBranch: "dev" }) }),
    entry("tiles-spike", { summary: summary({ lastCommitAt: 1_704_090_000 }) }),
    worktree("claude-auth", `${CODE}/geoportal`, {
      summary: summary({ currentBranch: "claude/fix-auth", ahead: 5, behind: 1 }),
    }),
  ];
}

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

interface BackendOptions {
  entries?: IndexEntry[];
  /** Messages a scan streams before `done`. */
  scan?: ScanMessage[];
  /** The scan's terminal message waits for this promise (to test Stop). */
  scanGate?: Promise<void>;
  /** The scan ends with this error instead of `done`. */
  scanError?: { code: string; message: string };
  /** `open_repository` rejects with `repo.not_found`. */
  openFails?: boolean;
  /** `pin_repository` rejects. */
  pinFails?: boolean;
}

/** A fake backend holding the index in memory, so listings reflect pins, forgets and opens. */
function mockBackend(options: BackendOptions = {}) {
  const calls: Call[] = [];
  let entries = options.entries ?? fixture();
  const send = (channel: Channel<unknown>, messages: unknown[], gate?: Promise<void>) => {
    const deliver = () => {
      for (const message of messages) channel.onmessage(message);
    };
    if (gate) void gate.then(deliver);
    else queueMicrotask(deliver);
  };
  const reject = (code: string, message: string) =>
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the serialised AppError object
    Promise.reject({ code, message });
  mockIPC((cmd, rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    const path = args["path"] as string;
    switch (cmd) {
      case "list_repositories":
        return entries.map((e) => ({ ...e }));
      case "pin_repository":
        if (options.pinFails) return reject("index.database", "database is locked");
        entries = entries.map((e) =>
          e.path === path ? { ...e, pinned: args["pinned"] as boolean } : e,
        );
        return null;
      case "forget_repository":
        entries = entries.filter((e) => e.path !== path && e.parentPath !== path);
        return null;
      case "record_repository_open":
        entries = entries.map((e) => (e.path === path ? { ...e, lastOpenedAt: 1_704_100_000 } : e));
        return null;
      case "refresh_repository": {
        const found = entries.find((e) => e.path === path);
        if (!found || found.missing || options.openFails) {
          entries = entries.map((e) => (e.path === path ? { ...e, missing: true } : e));
          return reject("repo.not_found", `No Git repository found at or above ${path}`);
        }
        const refreshed = {
          ...found,
          summary: { ...found.summary, ahead: 9 },
          refreshedAt: 1_704_200_000,
        };
        entries = entries.map((e) => (e.path === path ? refreshed : e));
        return refreshed;
      }
      case "remove_scan_root": {
        const root = args["root"] as string;
        entries = entries
          .filter((e) => e.scanRoot !== root || e.pinned || e.lastOpenedAt !== null)
          .map((e) => (e.scanRoot === root ? { ...e, scanRoot: null } : e));
        return null;
      }
      case "scan_folders": {
        const messages: unknown[] = (options.scan ?? []).map((data, seq) => ({
          kind: "page",
          seq,
          data,
        }));
        const channel = args["onPage"] as Channel<unknown>;
        if (options.scanGate) {
          send(channel, messages);
          send(channel, [{ kind: "done" }], options.scanGate);
        } else {
          messages.push(
            options.scanError ? { kind: "error", error: options.scanError } : { kind: "done" },
          );
          send(channel, messages);
        }
        return null;
      }
      case "cancel_operation":
        return true;
      case "open_repository":
        if (options.openFails) {
          return reject("repo.not_found", `No Git repository found at or above ${path}`);
        }
        return {
          root: path,
          commonDir: `${path}/.git`,
          currentBranch: "main",
          detached: false,
          isLinkedWorktree: false,
        };
      case "list_refs":
        return [];
      case "walk_commits":
        send(args["onPage"] as Channel<unknown>, [
          { kind: "page", seq: 0, data: { walkId: "w", index: 0, commits: [], done: true } },
          { kind: "done" },
        ]);
        return null;
      case "close_repository":
        return true;
      case "watch_repository":
        return null;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
  return { calls, current: () => entries };
}

async function settled(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function names(list: IndexEntry[]): string[] {
  return list.map((e) => e.name);
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage({ scanRoots: [CODE, WT] }), "linux");
});

afterEach(() => {
  clearMocks();
});

describe("index store", () => {
  it("loads the listing and derives mains, worktrees, pinned, recent and counts", async () => {
    mockBackend();
    const store = useIndexStore();
    expect(store.loaded).toBe(false);
    await store.load();
    expect(store.loaded).toBe(true);
    expect(store.loadError).toBeNull();
    expect(store.entries).toHaveLength(4);
    // Pinned first, then by name.
    expect(names(store.mains)).toEqual(["geoportal", "begitra", "tiles-spike"]);
    expect(names(store.worktreesOf(`${CODE}/geoportal`))).toEqual(["claude-auth"]);
    expect(store.worktreesOf(`${CODE}/begitra`)).toEqual([]);
    expect(names(store.pinned)).toEqual(["geoportal"]);
    // Recent excludes the pinned one and orders by last open, newest first.
    expect(names(store.recent)).toEqual(["begitra"]);
    expect(store.counts).toEqual({ repositories: 3, worktrees: 1, folders: 2 });
    expect(store.folderCounts(CODE)).toEqual({ repositories: 3, worktrees: 0 });
    expect(store.folderCounts(WT)).toEqual({ repositories: 0, worktrees: 1 });
  });

  it("keeps the error of a listing that fails and reports it as loaded", async () => {
    mockIPC(() => {
      throw new Error("no index here");
    });
    const store = useIndexStore();
    await store.load();
    expect(store.loaded).toBe(true);
    expect(store.loadError?.code).toBe("internal");
    expect(store.entries).toEqual([]);
  });

  it("sorts the All section by the chosen column and toggles the direction", async () => {
    mockBackend();
    const store = useIndexStore();
    await store.load();
    expect(store.sort).toEqual({ column: "name", direction: "asc" });
    expect(names(store.all)).toEqual(["begitra", "geoportal", "tiles-spike"]);
    store.setSort("name");
    expect(store.sort.direction).toBe("desc");
    expect(names(store.all)).toEqual(["tiles-spike", "geoportal", "begitra"]);
    store.setSort("branch");
    expect(store.sort).toEqual({ column: "branch", direction: "asc" });
    expect(names(store.all)).toEqual(["begitra", "geoportal", "tiles-spike"]);
    // Last commit starts with the newest first.
    store.setSort("lastCommit");
    expect(store.sort).toEqual({ column: "lastCommit", direction: "desc" });
    expect(names(store.all)).toEqual(["tiles-spike", "geoportal", "begitra"]);
  });

  it("scans the folders: found then updated upsert by path, counts and folder states flow, done stamps the scan", async () => {
    const fresh = entry("map-core-bench", {
      summary: summary({ currentBranch: null, lastCommitAt: null, dirty: null }),
    });
    const { calls } = mockBackend({
      scan: [
        { kind: "folder-started", folder: CODE },
        { kind: "progress", folder: CODE, scanned: 50, found: 0 },
        { kind: "found", entry: fresh },
        { kind: "updated", entry: { ...fresh, summary: summary({ currentBranch: "develop" }) } },
        { kind: "progress", folder: CODE, scanned: 312, found: 1 },
        { kind: "folder-done", folder: CODE, found: 1, missing: [] },
        { kind: "folder-started", folder: WT },
        { kind: "folder-done", folder: WT, found: 0, missing: [] },
      ],
    });
    const store = useIndexStore();
    const settings = useSettingsStore();
    const operations = useOperationsStore();
    await store.load();
    store.startScan();
    expect(store.scan).toEqual({
      kind: "scanning",
      folders: { [CODE]: "queued", [WT]: "queued" },
      scanned: 0,
      found: 0,
      current: null,
    });
    expect(store.isScanning).toBe(true);
    expect(operations.isBusy).toBe(true);
    // A second Scan while one runs is a no-op.
    store.startScan();
    await settled();
    const scan = calls.filter((c) => c.cmd === "scan_folders");
    expect(scan).toHaveLength(1);
    expect(scan[0]?.args).toMatchObject({
      folders: [CODE, WT],
      options: { maxDepth: 6 },
    });
    expect((scan[0]?.args["options"] as { skip: string[] }).skip).toContain("node_modules");
    expect(store.scan.kind).toBe("idle");
    expect(store.isScanning).toBe(false);
    expect(operations.isBusy).toBe(false);
    const found = store.entries.find((e) => e.name === "map-core-bench");
    expect(found?.summary.currentBranch).toBe("develop");
    expect(store.entries).toHaveLength(5);
    expect(store.lastScanAt).toBeGreaterThan(1_700_000_000);
    expect(settings.values.lastScanAt).toBe(store.lastScanAt);
    expect(store.scanError).toBeNull();
  });

  it("reports the folder states and the counts while the scan runs", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockBackend({
      scan: [
        { kind: "folder-started", folder: CODE },
        { kind: "progress", folder: CODE, scanned: 120, found: 3 },
        { kind: "found", entry: entry("style-editor") },
        { kind: "folder-done", folder: CODE, found: 4, missing: [] },
        { kind: "folder-started", folder: WT },
      ],
      scanGate: gate,
    });
    const store = useIndexStore();
    await store.load();
    store.startScan();
    await settled();
    expect(store.scan).toEqual({
      kind: "scanning",
      folders: { [CODE]: "done", [WT]: "scanning" },
      scanned: 120,
      found: 4,
      current: WT,
    });
    release();
    await settled();
    expect(store.scan.kind).toBe("idle");
  });

  it("stops a scan and keeps what it found", async () => {
    const gate = new Promise<void>(() => {});
    const { calls } = mockBackend({
      scan: [
        { kind: "folder-started", folder: CODE },
        { kind: "found", entry: entry("ogc-fixtures") },
      ],
      scanGate: gate,
    });
    const store = useIndexStore();
    await store.load();
    store.startScan();
    await settled();
    expect(store.isScanning).toBe(true);
    await store.stopScan();
    await settled();
    expect(store.isScanning).toBe(false);
    expect(store.scanError).toBeNull();
    expect(names(store.entries)).toContain("ogc-fixtures");
    expect(calls.some((c) => c.cmd === "cancel_operation")).toBe(true);
    expect(store.lastScanAt).not.toBeNull();
    expect(useOperationsStore().isBusy).toBe(false);
  });

  it("flags a folder that could not be scanned until a scan finds it again, and marks stale entries missing", async () => {
    mockBackend({
      scan: [
        { kind: "folder-started", folder: CODE },
        { kind: "folder-done", folder: CODE, found: 2, missing: [`${CODE}/tiles-spike`] },
        { kind: "folder-started", folder: WT },
        {
          kind: "folder-error",
          folder: WT,
          reason: "The system cannot find the path specified. (os error 3)",
        },
      ],
    });
    const store = useIndexStore();
    await store.load();
    store.startScan();
    await settled();
    expect(store.scan.kind).toBe("idle");
    expect(store.folderErrors).toEqual({
      [WT]: { reason: "The system cannot find the path specified. (os error 3)" },
    });
    expect(store.failedFolders).toEqual([WT]);
    expect(store.entries.find((e) => e.name === "tiles-spike")?.missing).toBe(true);

    // The next scan finds the folder again: the flag goes away when the folder completes.
    clearMocks();
    mockBackend({
      scan: [
        { kind: "folder-started", folder: WT },
        { kind: "folder-done", folder: WT, found: 1, missing: [] },
      ],
    });
    store.startScan([WT]);
    expect(store.scan).toMatchObject({ folders: { [WT]: "queued" } });
    await settled();
    expect(store.folderErrors).toEqual({});
  });

  it("keeps the error of a scan that fails", async () => {
    mockBackend({ scanError: { code: "index.database", message: "database is locked" } });
    const store = useIndexStore();
    await store.load();
    store.startScan();
    await settled();
    expect(store.scan.kind).toBe("idle");
    expect(store.scanError?.code).toBe("index.database");
    expect(store.lastScanAt).toBeNull();
    store.startScan();
    expect(store.scanError).toBeNull();
  });

  it("does not scan without folders", () => {
    const { calls } = mockBackend();
    const store = useIndexStore();
    store.startScan([]);
    expect(store.scan.kind).toBe("idle");
    expect(calls).toEqual([]);
  });

  it("pins and unpins at once and reverts when the backend refuses", async () => {
    const backend = mockBackend();
    const store = useIndexStore();
    await store.load();
    const pinning = store.pin(`${CODE}/begitra`, true);
    expect(names(store.pinned)).toEqual(["begitra", "geoportal"]);
    await pinning;
    expect(backend.current().find((e) => e.name === "begitra")?.pinned).toBe(true);
    await store.pin(`${CODE}/geoportal`, false);
    expect(names(store.pinned)).toEqual(["begitra"]);
    expect(names(store.recent)).toEqual(["geoportal"]);

    clearMocks();
    mockBackend({ pinFails: true });
    await store.pin(`${CODE}/tiles-spike`, true);
    expect(names(store.pinned)).toEqual(["begitra"]);
    expect(useToastsStore().toasts).toHaveLength(1);
    expect(useToastsStore().toasts[0]?.message).toContain("database is locked");
  });

  it("forgets an entry together with its worktrees", async () => {
    const { calls } = mockBackend();
    const store = useIndexStore();
    await store.load();
    await store.forget(`${CODE}/geoportal`);
    expect(names(store.entries)).toEqual(["begitra", "tiles-spike"]);
    expect(calls.find((c) => c.cmd === "forget_repository")?.args).toEqual({
      path: `${CODE}/geoportal`,
    });
  });

  it("open records the open, delegates to the repository store and syncs the listing", async () => {
    const { calls } = mockBackend();
    const store = useIndexStore();
    const repo = useRepoStore();
    await store.load();
    await store.open(`${CODE}/tiles-spike`);
    await settled();
    expect(repo.state.kind).toBe("ready");
    expect(repo.repo?.root).toBe(`${CODE}/tiles-spike`);
    const order = calls.map((c) => c.cmd);
    expect(order.indexOf("record_repository_open")).toBeLessThan(order.indexOf("open_repository"));
    expect(order.filter((c) => c === "list_repositories")).toHaveLength(2);
    expect(store.entries.find((e) => e.name === "tiles-spike")?.lastOpenedAt).toBeGreaterThan(
      1_704_100_000,
    );
    expect(names(store.recent)).toEqual(["tiles-spike", "begitra"]);
  });

  it("open asks for the entry of a folder outside the index and reloads the listing back home", async () => {
    const { calls } = mockBackend();
    const store = useIndexStore();
    const repo = useRepoStore();
    await store.load();
    await store.open("/home/iker/oss/newcomer");
    await settled();
    expect(repo.state.kind).toBe("ready");
    expect(calls.filter((c) => c.cmd === "refresh_repository").map((c) => c.args["path"])).toEqual([
      "/home/iker/oss/newcomer",
    ]);
    const listings = calls.filter((c) => c.cmd === "list_repositories").length;
    await repo.close();
    await settled();
    expect(calls.filter((c) => c.cmd === "list_repositories")).toHaveLength(listings + 1);
  });

  it("open flags the entry missing when the folder is gone and leaves the error state to the shell", async () => {
    mockBackend({ openFails: true });
    const store = useIndexStore();
    const repo = useRepoStore();
    await store.load();
    await store.open(`${CODE}/begitra`);
    expect(repo.state.kind).toBe("error");
    expect(store.entries.find((e) => e.name === "begitra")?.missing).toBe(true);
  });

  it("restore reopens the last repository and, when it is gone, returns the error and goes home flagged", async () => {
    mockBackend();
    const store = useIndexStore();
    const repo = useRepoStore();
    await store.load();
    expect(await store.restore(`${CODE}/geoportal`)).toBeNull();
    expect(repo.state.kind).toBe("ready");

    clearMocks();
    mockBackend({ openFails: true });
    const failed = await store.restore(`${CODE}/begitra`);
    expect(failed?.code).toBe("repo.not_found");
    expect(repo.state.kind).toBe("empty");
    expect(store.entries.find((e) => e.name === "begitra")?.missing).toBe(true);
  });

  it("refresh upserts the entry and flags a vanished one", async () => {
    mockBackend();
    const store = useIndexStore();
    await store.load();
    await store.refresh(`${CODE}/begitra`);
    expect(store.entries.find((e) => e.name === "begitra")?.summary.ahead).toBe(9);
    await store.refresh(`${CODE}/nowhere`);
    expect(store.entries.some((e) => e.name === "nowhere")).toBe(false);
    store.entries = [...store.entries, entry("gone", { missing: true })];
    await store.refresh(`${CODE}/gone`);
    expect(store.entries.find((e) => e.name === "gone")?.missing).toBe(true);
  });

  it("removeRoot drops the folder from the settings and its entries from the index", async () => {
    const { calls } = mockBackend();
    const store = useIndexStore();
    const settings = useSettingsStore();
    await store.load();
    await store.removeRoot(WT);
    expect(settings.values.scanRoots).toEqual([CODE]);
    expect(calls.find((c) => c.cmd === "remove_scan_root")?.args).toEqual({ root: WT });
    expect(names(store.entries)).toEqual(["geoportal", "begitra", "tiles-spike"]);
    expect(store.counts.folders).toBe(1);
    // A flagged folder loses its flag with its entry.
    store.folderErrors = { [CODE]: { reason: "gone" } };
    await store.removeRoot(CODE);
    expect(store.folderErrors).toEqual({});
    // Pinned and opened entries survive without a scan folder.
    expect(names(store.entries)).toEqual(["geoportal", "begitra"]);
  });

  it("addRoot appends the folder once and scans it", async () => {
    const { calls } = mockBackend({ scan: [] });
    const store = useIndexStore();
    const settings = useSettingsStore();
    expect(store.addRoot("/home/iker/oss")).toBe(true);
    expect(settings.values.scanRoots).toEqual([CODE, WT, "/home/iker/oss"]);
    expect(store.scan).toMatchObject({ kind: "scanning", folders: { "/home/iker/oss": "queued" } });
    await settled();
    expect(calls.find((c) => c.cmd === "scan_folders")?.args).toMatchObject({
      folders: ["/home/iker/oss"],
    });
    expect(store.addRoot("/home/iker/oss/")).toBe(false);
    expect(settings.values.scanRoots).toHaveLength(3);
  });
});
