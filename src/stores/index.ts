// The repository index: every repository and worktree of a project, as the scans found them
// and the opens described them, the scan in progress with its per-folder states and counts,
// and the folders that could not be scanned. Entries come from the backend's SQLite index; the
// store keeps a copy, applies scan messages as they stream in, and drops the entries a project
// write took out of the index. The folders it scans are the folder projects'.

import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";

import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type { IndexEntry, ScanMessage } from "@/ipc/schemas";
import type { StreamHandle } from "@/ipc/stream";
import { sameFolder } from "@/shell/format";

import { useOperationsStore } from "./operations";
import { useProjectsStore } from "./projects";
import { useRepoStore } from "./repo";
import { useSettingsStore } from "./settings";

export type FolderScanState = "queued" | "scanning" | "done" | "error";

export interface ScanProgress {
  kind: "scanning";
  /** State of every folder of this scan, keyed by the folder as its project spells it. */
  folders: Record<string, FolderScanState>;
  /** Directories read so far, over every folder. */
  scanned: number;
  /** Repositories and worktrees found so far. */
  found: number;
  /** The folder being walked. */
  current: string | null;
}

export type ScanState = { kind: "idle" } | ScanProgress;

export interface FolderError {
  /** The operating system's reason, shown behind "Show details". */
  reason: string;
}

function byName(a: IndexEntry, b: IndexEntry): number {
  return (
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.path.localeCompare(b.path)
  );
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export const useIndexStore = defineStore("index", () => {
  const settings = useSettingsStore();
  const operations = useOperationsStore();
  // The projects store reads this one at setup: it is asked for when needed, never here.
  const projects = () => useProjectsStore();

  // Entries are replaced as a whole on every change (a few hundred at most): a shallow ref
  // spares a reactive proxy per entry.
  const entries = shallowRef<IndexEntry[]>([]);
  /** Whether the first listing finished, successfully or not. */
  const loaded = ref(false);
  const loading = ref(false);
  const loadError = ref<AppError | null>(null);
  /** Whether `entries` are the index's: listed, and the last listing did not fail. */
  const read = computed(() => loaded.value && loadError.value === null);
  const scan = ref<ScanState>({ kind: "idle" });
  /** The error that ended the last scan, other than a stop. */
  const scanError = ref<AppError | null>(null);
  /** Folders the last scans could not read; one leaves when it scans again or its project goes. */
  const folderErrors = ref<Record<string, FolderError>>({});

  let scanHandle: StreamHandle | null = null;

  const isScanning = computed(() => scan.value.kind === "scanning");
  const lastScanAt = computed(() => settings.values.lastScanAt);

  /** Main repositories, by name. */
  const mains = computed(() => entries.value.filter((entry) => entry.kind === "main").sort(byName));
  const worktrees = computed(() => entries.value.filter((entry) => entry.kind === "worktree"));
  const counts = computed(() => ({
    repositories: mains.value.length,
    worktrees: worktrees.value.length,
  }));

  function worktreesOf(path: string): IndexEntry[] {
    return worktrees.value.filter((entry) => entry.parentPath === path).sort(byName);
  }

  function find(path: string): IndexEntry | undefined {
    return entries.value.find((entry) => entry.path === path);
  }

  /** The entry of `path` however it is spelled. */
  function lookup(path: string): IndexEntry | undefined {
    return find(path) ?? entries.value.find((entry) => sameFolder(entry.path, path));
  }

  function upsert(entry: IndexEntry): void {
    const index = entries.value.findIndex((candidate) => candidate.path === entry.path);
    if (index < 0) {
      entries.value = [...entries.value, entry];
    } else {
      const next = entries.value.slice();
      next[index] = entry;
      entries.value = next;
    }
  }

  function patch(path: string, changes: Partial<IndexEntry>): void {
    if (!find(path)) return;
    entries.value = entries.value.map((entry) =>
      entry.path === path ? { ...entry, ...changes } : entry,
    );
  }

  function markMissing(paths: string[]): void {
    if (paths.length === 0) return;
    const gone = new Set(paths);
    entries.value = entries.value.map((entry) =>
      gone.has(entry.path) ? { ...entry, missing: true } : entry,
    );
  }

  /** Drops the entries a project write took out of the index (they belong to no project). */
  function drop(paths: readonly string[]): void {
    if (paths.length === 0) return;
    entries.value = entries.value.filter(
      (entry) => !paths.some((path) => sameFolder(path, entry.path)),
    );
  }

  /** Lists the index; a failure is kept in `loadError` and the entries stay as they were. */
  async function load(): Promise<void> {
    loading.value = true;
    try {
      entries.value = await ipc.listRepositories();
      loadError.value = null;
    } catch (error) {
      loadError.value = toAppError(error);
    } finally {
      loaded.value = true;
      loading.value = false;
    }
  }

  /** Every folder project's folder, as the projects spell them. */
  const folders = computed(() => projects().folders);

  /** The projects' spelling of a folder a scan message names, or the message's own. */
  function projectFolder(folder: string): string {
    return folders.value.find((known) => sameFolder(known, folder)) ?? folder;
  }

  function withFolder(
    progress: ScanProgress,
    folder: string,
    state: FolderScanState,
  ): ScanProgress {
    return { ...progress, folders: { ...progress.folders, [folder]: state } };
  }

  function clearFolderError(folder: string): void {
    const known = Object.keys(folderErrors.value).find((key) => sameFolder(key, folder));
    if (known === undefined) return;
    folderErrors.value = Object.fromEntries(
      Object.entries(folderErrors.value).filter(([key]) => key !== known),
    );
  }

  function apply(message: ScanMessage): void {
    const current = scan.value;
    if (current.kind !== "scanning") return;
    switch (message.kind) {
      case "folder-started": {
        const folder = projectFolder(message.folder);
        scan.value = { ...withFolder(current, folder, "scanning"), current: folder };
        break;
      }
      case "progress":
        scan.value = {
          ...current,
          scanned: message.scanned,
          found: Math.max(current.found, message.found),
        };
        break;
      case "found":
        upsert(message.entry);
        scan.value = { ...current, found: current.found + 1 };
        // The backend made it one of the walked folder's own members.
        if (current.current !== null) projects().noteFound(message.entry, current.current);
        break;
      case "updated":
        upsert(message.entry);
        break;
      case "folder-done": {
        const folder = projectFolder(message.folder);
        scan.value = withFolder(current, folder, "done");
        clearFolderError(folder);
        markMissing(message.missing);
        // The members it did not find left its project, and the index when no other project
        // holds them: both lists are read again.
        void projects().load();
        void load();
        break;
      }
      case "folder-error": {
        const folder = projectFolder(message.folder);
        scan.value = withFolder(current, folder, "error");
        folderErrors.value = { ...folderErrors.value, [folder]: { reason: message.reason } };
        break;
      }
    }
  }

  /** Folders asked for while a scan runs: queued in its folder states, scanned when it ends. */
  let queued: string[] = [];

  /**
   * Scans `which` (every folder project's folder by default) with the settings' skip list and
   * depth, applying the messages as they arrive. While a scan runs, the folders it does not
   * cover wait for it and are scanned once it ends; the ones it covers are left alone.
   */
  function startScan(which: string[] = folders.value): void {
    if (which.length === 0) return;
    const running = scan.value;
    if (running.kind === "scanning") {
      const waiting = which.filter(
        (folder) =>
          !Object.keys(running.folders).some((known) => sameFolder(known, folder)) &&
          !queued.some((known) => sameFolder(known, folder)),
      );
      if (waiting.length === 0) return;
      queued = [...queued, ...waiting];
      scan.value = waiting.reduce(
        (progress, folder) => withFolder(progress, folder, "queued"),
        running,
      );
      return;
    }
    const states: Record<string, FolderScanState> = {};
    for (const folder of which) states[folder] = "queued";
    scan.value = { kind: "scanning", folders: states, scanned: 0, found: 0, current: null };
    scanError.value = null;
    const opId = newOpId("scan");
    operations.start(opId, "operations.scanning");
    const handle = ipc.scanFolders(
      which,
      apply,
      { skip: settings.values.skipFolders, maxDepth: settings.values.maxDepth },
      opId,
    );
    scanHandle = handle;
    void handle.done
      .then(
        () => {
          void settings.update("lastScanAt", nowSeconds());
        },
        (error: unknown) => {
          const failed = toAppError(error);
          if (failed.code === "op.cancelled") void settings.update("lastScanAt", nowSeconds());
          else scanError.value = failed;
        },
      )
      .finally(() => {
        if (scanHandle === handle) scanHandle = null;
        scan.value = { kind: "idle" };
        operations.finish(opId);
        // The folders that waited, unless their project went meanwhile.
        const next = queued.filter((folder) =>
          folders.value.some((known) => sameFolder(known, folder)),
        );
        queued = [];
        startScan(next);
      });
  }

  /** Stops the running scan and drops the folders waiting for it; what it found stays. */
  async function stopScan(): Promise<void> {
    queued = [];
    await scanHandle?.cancel();
  }

  /** Forgets what the scans said of `folder`, whose project went. */
  function forgetFolder(folder: string): void {
    clearFolderError(folder);
    queued = queued.filter((known) => !sameFolder(known, folder));
  }

  /**
   * Describes one entry again and stores the result; a vanished one is flagged missing. Without
   * `dirty` the working tree is not scanned and the stored dirty flag stays: for the open
   * repository, whose flag nothing shows until it is no longer open. Resolves with the reason
   * the entry could not be read, null when it was.
   */
  async function refresh(path: string, dirty = true): Promise<AppError | null> {
    try {
      upsert(await ipc.refreshRepository(path, dirty));
      return null;
    } catch (error) {
      const failed = toAppError(error);
      if (failed.code === "repo.not_found") markMissing([path]);
      return failed;
    }
  }

  /**
   * Describes the repository or worktree at `path` without opening it ("Add repository…"): the
   * entry spelled as the index spells it, or why it could not (`repo.not_found` for a folder
   * that lies in no repository). The backend stores it only once a project names it, so a
   * dialog cancelled after the probe leaves nothing in the index. Its summary is read without a
   * status of the working tree: the dirty flag stays unknown until a scan reads it.
   */
  async function describe(path: string): Promise<IndexEntry | AppError> {
    try {
      return await ipc.refreshRepository(path, false);
    } catch (error) {
      return toAppError(error);
    }
  }

  /**
   * Syncs the listing after an open. The backend records the open and refreshes the entry
   * off the open's critical path, so a repository opened from outside the index may not be
   * listed yet: it is asked for on its own, and its recents position is set here and now. A
   * folder that is gone flags its entry.
   */
  async function afterOpen(path: string): Promise<void> {
    const repo = useRepoStore();
    if (repo.state.kind === "ready") {
      const root = repo.repo?.root ?? path;
      await load();
      if (!lookup(root)) await refresh(root, false);
      patch(lookup(root)?.path ?? root, { lastOpenedAt: nowSeconds() });
    } else if (repo.state.kind === "error" && repo.state.error.code === "repo.not_found") {
      markMissing([lookup(path)?.path ?? path]);
      // The backend flags the entry too, so the mark survives the next listing.
      void ipc.refreshRepository(path, false).catch(() => undefined);
    }
  }

  // Back on Home, the listing is read again: the summary the backend refreshed while the
  // repository was open lands without a scan.
  watch(
    () => useRepoStore().state.kind,
    (kind, previous) => {
      if (kind === "empty" && previous !== undefined && previous !== "empty") void load();
    },
  );

  // The open repository's dirty flag is left alone while it is open; it is read once when the
  // repository stops being the open one. Back on Home, the listing read on the way may land
  // after that refresh and hold the flag from before it, so the listing is read once more.
  watch(
    () => useRepoStore().repo?.root,
    (now, before) => {
      if (before === undefined || before === now) return;
      void refresh(before, true).then(() => {
        if (useRepoStore().state.kind === "empty") return load();
      });
    },
  );

  return {
    entries,
    loaded,
    loading,
    loadError,
    read,
    scan,
    scanError,
    folderErrors,
    isScanning,
    lastScanAt,
    mains,
    worktrees,
    counts,
    folders,
    worktreesOf,
    find,
    lookup,
    load,
    startScan,
    stopScan,
    forgetFolder,
    refresh,
    describe,
    drop,
    markMissing,
    afterOpen,
  };
});
