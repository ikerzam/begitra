import type { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IndexEntry, Project, RepoSummary, ScanMessage } from "@/ipc/schemas";

import { useIndexStore } from "./index";
import { useOperationsStore } from "./operations";
import { useProjectsStore } from "./projects";
import { useRepoStore } from "./repo";
import { memoryStorage, useSettingsStore } from "./settings";

const CODE = "/home/iker/code";
const WT = "/home/iker/wt";

function summary(over: Partial<RepoSummary> = {}): RepoSummary {
  return {
    currentBranch: "main",
    detached: false,
    ahead: 0,
    behind: 0,
    lastCommitAt: 1_704_000_000,
    upstream: null,
    operation: null,
    fetchedAt: null,
    lastCommitSubject: null,
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
  /** The folder projects, by folder; `CODE` and `WT` by default. */
  folders?: string[];
  /** Messages a scan streams before `done`. */
  scan?: ScanMessage[];
  /** The scan's terminal message waits for this promise (to test Stop). */
  scanGate?: Promise<void>;
  /** The scan ends with this error instead of `done`. */
  scanError?: { code: string; message: string };
  /** `open_repository` rejects with `repo.not_found`. */
  openFails?: boolean;
}

/** A folder project of `folder` holding nothing (the tests of the scan give its members). */
function folderProject(id: number, folder: string): Project {
  return {
    id,
    name: folder.slice(folder.lastIndexOf("/") + 1),
    kind: "folder",
    folder,
    members: [],
    pinned: false,
    openedAt: null,
    lastRepository: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** A fake backend holding the index in memory, so listings reflect what the store asked. */
function mockBackend(options: BackendOptions = {}) {
  const calls: Call[] = [];
  let entries = options.entries ?? fixture();
  let folders = options.folders ?? [CODE, WT];
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
      case "projects":
        return folders.map((folder, at) => folderProject(at + 1, folder));
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
      case "scan_folders": {
        // The backend stores what the scan finds before it streams it.
        for (const message of options.scan ?? []) {
          if (message.kind !== "found" && message.kind !== "updated") continue;
          const stored = message.entry;
          entries = [...entries.filter((e) => e.path !== stored.path), stored];
        }
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
  return {
    calls,
    current: () => entries,
    setFolders: (next: string[]) => {
      folders = next;
    },
  };
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
  await useSettingsStore().init(memoryStorage(), "linux");
});

/** Lists the index and the projects, whose folder projects are the scan's folders. */
async function loaded(): Promise<ReturnType<typeof useIndexStore>> {
  const store = useIndexStore();
  await Promise.all([store.load(), useProjectsStore().load()]);
  return store;
}

afterEach(() => {
  clearMocks();
});

describe("index store", () => {
  it("loads the listing and derives mains, worktrees and counts", async () => {
    mockBackend();
    const store = useIndexStore();
    expect(store.loaded).toBe(false);
    await store.load();
    expect(store.loaded).toBe(true);
    expect(store.read).toBe(true);
    expect(store.loadError).toBeNull();
    expect(store.entries).toHaveLength(4);
    expect(names(store.mains)).toEqual(["begitra", "geoportal", "tiles-spike"]);
    expect(names(store.worktreesOf(`${CODE}/geoportal`))).toEqual(["claude-auth"]);
    expect(store.worktreesOf(`${CODE}/begitra`)).toEqual([]);
    expect(store.counts).toEqual({ repositories: 3, worktrees: 1 });
    expect(store.lookup(`${CODE}/Begitra/`)).toBeUndefined();
    expect(store.lookup(`${CODE}/begitra/`)?.name).toBe("begitra");
  });

  it("keeps the error of a listing that fails and reports it as loaded", async () => {
    mockIPC(() => {
      throw new Error("no index here");
    });
    const store = useIndexStore();
    await store.load();
    expect(store.loaded).toBe(true);
    expect(store.read).toBe(false);
    expect(store.loadError?.code).toBe("internal");
    expect(store.entries).toEqual([]);
  });

  it("scans the folder projects' folders: found then updated upsert by path, states flow, done stamps the scan", async () => {
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
    const store = await loaded();
    const settings = useSettingsStore();
    const operations = useOperationsStore();
    expect(store.folders).toEqual([CODE, WT]);
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
    expect(scan[0]?.args).toMatchObject({ folders: [CODE, WT], options: { maxDepth: 2 } });
    expect((scan[0]?.args["options"] as { skip: string[] }).skip).toContain("node_modules");
    expect(store.scan.kind).toBe("idle");
    expect(store.isScanning).toBe(false);
    expect(operations.isBusy).toBe(false);
    const found = store.entries.find((e) => e.name === "map-core-bench");
    expect(found?.summary.currentBranch).toBe("develop");
    expect(store.lastScanAt).toBeGreaterThan(1_700_000_000);
    expect(settings.values.lastScanAt).toBe(store.lastScanAt);
    expect(store.scanError).toBeNull();
    // Each folder's end reads the projects and the listing again: the members it dropped left.
    expect(calls.filter((c) => c.cmd === "projects")).toHaveLength(3);
  });

  it("makes a found repository one of the walked folder project's own members at once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const found = entry("style-editor");
    mockBackend({
      scan: [
        { kind: "folder-started", folder: CODE },
        { kind: "found", entry: found },
      ],
      scanGate: gate,
    });
    const store = await loaded();
    const projects = useProjectsStore();
    store.startScan();
    await settled();
    expect(projects.folderProjectOf(CODE)?.members).toEqual([
      { path: found.path, origin: "folder" },
    ]);
    expect(projects.folderProjectOf(WT)?.members).toEqual([]);
    release();
    await settled();
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
    const store = await loaded();
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
    const store = await loaded();
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
    const store = await loaded();
    store.startScan();
    await settled();
    expect(store.scan.kind).toBe("idle");
    expect(store.folderErrors).toEqual({
      [WT]: { reason: "The system cannot find the path specified. (os error 3)" },
    });

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

  it("marks the members a folder's end names missing until the listing says otherwise", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockBackend({
      scan: [{ kind: "folder-done", folder: CODE, found: 2, missing: [`${CODE}/tiles-spike`] }],
      scanGate: gate,
    });
    const store = await loaded();
    store.startScan([CODE]);
    await Promise.resolve();
    await Promise.resolve();
    expect(store.entries.find((e) => e.name === "tiles-spike")?.missing).toBe(true);
    release();
    await settled();
  });

  it("keeps the error of a scan that fails", async () => {
    mockBackend({ scanError: { code: "index.database", message: "database is locked" } });
    const store = await loaded();
    store.startScan();
    await settled();
    expect(store.scan.kind).toBe("idle");
    expect(store.scanError?.code).toBe("index.database");
    expect(store.lastScanAt).toBeNull();
    store.startScan();
    expect(store.scanError).toBeNull();
  });

  it("does not scan without folders", async () => {
    const { calls } = mockBackend({ folders: [] });
    const store = await loaded();
    store.startScan();
    store.startScan([]);
    expect(store.scan.kind).toBe("idle");
    expect(calls.filter((c) => c.cmd === "scan_folders")).toEqual([]);
  });

  it("scans a folder asked for during a scan once that scan ends, unless its project went", async () => {
    let release = (): void => undefined;
    const scanGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backend = mockBackend({ scanGate, folders: [CODE, WT, "/home/iker/more"] });
    const store = await loaded();
    store.startScan([CODE]);
    store.startScan(["/home/iker/more", WT]);
    expect(store.scan).toMatchObject({
      kind: "scanning",
      folders: { [CODE]: "queued", "/home/iker/more": "queued", [WT]: "queued" },
    });
    // The project of ~/wt goes while it waits.
    backend.setFolders([CODE, "/home/iker/more"]);
    await useProjectsStore().load();
    store.forgetFolder(WT);
    await settled();
    const scanned = () =>
      backend.calls.filter((c) => c.cmd === "scan_folders").map((c) => c.args["folders"]);
    expect(scanned()).toEqual([[CODE]]);
    release();
    await settled();
    expect(scanned()).toEqual([[CODE], ["/home/iker/more"]]);
    expect(store.scan.kind).toBe("idle");
  });

  it("Stop drops the folders waiting for the scan", async () => {
    let release = (): void => undefined;
    const scanGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { calls } = mockBackend({ scanGate });
    const store = await loaded();
    store.startScan([CODE]);
    store.startScan([WT]);
    await store.stopScan();
    release();
    await settled();
    expect(calls.filter((c) => c.cmd === "scan_folders").map((c) => c.args["folders"])).toEqual([
      [CODE],
    ]);
    expect(store.scan.kind).toBe("idle");
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

  it("describes a repository for Add repository without storing it, and drops what a project write removed", async () => {
    mockBackend();
    const store = useIndexStore();
    await store.load();
    store.entries = store.entries.filter((e) => e.name !== "begitra");
    const described = await store.describe(`${CODE}/begitra`);
    expect("path" in described && described.name).toBe("begitra");
    expect(store.find(`${CODE}/begitra`)).toBeUndefined();
    const failed = await store.describe("/home/iker/not-a-repository");
    expect("code" in failed && failed.code).toBe("repo.not_found");
    store.drop([`${CODE}/geoportal`, `${WT}/claude-auth/`]);
    expect(names(store.entries)).toEqual(["tiles-spike"]);
  });

  it("syncs the listing after an open, asking for a repository it does not list, and reads it again back home", async () => {
    const { calls } = mockBackend();
    const store = useIndexStore();
    const repo = useRepoStore();
    await store.load();
    await repo.open("/home/iker/oss/newcomer");
    await store.afterOpen("/home/iker/oss/newcomer");
    await settled();
    expect(repo.state.kind).toBe("ready");
    const refreshes = () =>
      calls
        .filter((c) => c.cmd === "refresh_repository")
        .map((c) => [c.args["path"], c.args["dirty"]]);
    // Open: without the dirty flag, which nothing shows while the repository is open.
    expect(refreshes()).toEqual([["/home/iker/oss/newcomer", false]]);
    const listings = calls.filter((c) => c.cmd === "list_repositories").length;
    await repo.close();
    await settled();
    // Back home: the closed repository's flag is read, then the listing again after it.
    expect(refreshes()).toEqual([
      ["/home/iker/oss/newcomer", false],
      ["/home/iker/oss/newcomer", true],
    ]);
    expect(calls.filter((c) => c.cmd === "list_repositories")).toHaveLength(listings + 2);
  });

  it("flags the entry missing when its folder is gone at an open", async () => {
    mockBackend({ openFails: true });
    const store = useIndexStore();
    const repo = useRepoStore();
    await store.load();
    await repo.open(`${CODE}/begitra`);
    await store.afterOpen(`${CODE}/begitra`);
    expect(repo.state.kind).toBe("error");
    expect(store.entries.find((e) => e.name === "begitra")?.missing).toBe(true);
  });
});
