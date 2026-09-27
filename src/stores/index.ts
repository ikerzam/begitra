// The repository index: every repository and worktree the scanner found or the user opened,
// the scan in progress with its per-folder states and counts, the folders that could not be
// scanned, and the sort of the home table. Entries come from the backend's SQLite index; the
// store keeps a copy, applies scan messages as they stream in, and updates it optimistically
// on pin, forget and open.

import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";

import { i18n } from "@/i18n";
import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type { IndexEntry, ScanMessage } from "@/ipc/schemas";
import type { StreamHandle } from "@/ipc/stream";
import { errorText } from "@/shell/errorMessage";
import { sameFolder } from "@/shell/format";

import { useOperationsStore } from "./operations";
import { useRepoStore } from "./repo";
import { useSettingsStore } from "./settings";
import { useToastsStore } from "./toasts";

export type FolderScanState = "queued" | "scanning" | "done" | "error";

export interface ScanProgress {
  kind: "scanning";
  /** State of every folder of this scan, keyed by the folder as the settings spell it. */
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
  /** The operating system's reason, shown behind "Show git output". */
  reason: string;
}

export type SortColumn = "name" | "branch" | "lastCommit";
export type SortDirection = "asc" | "desc";

export interface TableSort {
  column: SortColumn;
  direction: SortDirection;
}

export interface FolderCounts {
  repositories: number;
  worktrees: number;
}

/** Entries listed under Recent: the last opened ones that are not pinned. */
export const RECENT_REPOSITORIES = 5;

function byName(a: IndexEntry, b: IndexEntry): number {
  return (
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.path.localeCompare(b.path)
  );
}

function byBranch(a: IndexEntry, b: IndexEntry): number {
  const left = a.summary.currentBranch ?? "";
  const right = b.summary.currentBranch ?? "";
  return left.localeCompare(right, undefined, { sensitivity: "base" }) || byName(a, b);
}

function byLastCommit(a: IndexEntry, b: IndexEntry): number {
  const left = a.summary.lastCommitAt ?? Number.NEGATIVE_INFINITY;
  const right = b.summary.lastCommitAt ?? Number.NEGATIVE_INFINITY;
  return left - right || byName(a, b);
}

const comparators: Record<SortColumn, (a: IndexEntry, b: IndexEntry) => number> = {
  name: byName,
  branch: byBranch,
  lastCommit: byLastCommit,
};

/** The direction a column starts with: dates newest first, text A to Z. */
const defaultDirections: Record<SortColumn, SortDirection> = {
  name: "asc",
  branch: "asc",
  lastCommit: "desc",
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export const useIndexStore = defineStore("index", () => {
  const settings = useSettingsStore();
  const operations = useOperationsStore();
  const toasts = useToastsStore();

  // Entries are replaced as a whole on every change (a few hundred at most): a shallow ref
  // spares a reactive proxy per entry.
  const entries = shallowRef<IndexEntry[]>([]);
  /** Whether the first listing finished, successfully or not. */
  const loaded = ref(false);
  const loading = ref(false);
  const loadError = ref<AppError | null>(null);
  const scan = ref<ScanState>({ kind: "idle" });
  /** The error that ended the last scan, other than a stop. */
  const scanError = ref<AppError | null>(null);
  /** Folders the last scans could not read; a folder leaves when it is removed or scans again. */
  const folderErrors = ref<Record<string, FolderError>>({});
  const sort = ref<TableSort>({ column: "name", direction: "asc" });

  let scanHandle: StreamHandle | null = null;

  const isScanning = computed(() => scan.value.kind === "scanning");
  const lastScanAt = computed(() => settings.values.lastScanAt);
  const scanRoots = computed(() => settings.values.scanRoots);

  /** Main repositories, pinned first, then by name. */
  const mains = computed(() =>
    entries.value
      .filter((entry) => entry.kind === "main")
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || byName(a, b)),
  );
  const worktrees = computed(() => entries.value.filter((entry) => entry.kind === "worktree"));
  /** Pinned repositories and worktrees, by name. */
  const pinned = computed(() => entries.value.filter((entry) => entry.pinned).sort(byName));
  /** The last opened entries that are not pinned, newest first. */
  const recent = computed(() =>
    entries.value
      .filter((entry) => entry.lastOpenedAt !== null && !entry.pinned)
      .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) || byName(a, b))
      .slice(0, RECENT_REPOSITORIES),
  );
  /** Every main repository in the order of the table sort. */
  const all = computed(() => {
    const compare = comparators[sort.value.column];
    const sign = sort.value.direction === "asc" ? 1 : -1;
    return entries.value
      .filter((entry) => entry.kind === "main")
      .sort((a, b) => sign * compare(a, b));
  });
  const counts = computed(() => ({
    repositories: mains.value.length,
    worktrees: worktrees.value.length,
    folders: scanRoots.value.length,
  }));
  /** Folders flagged by the last scans, in the order of the settings. */
  const failedFolders = computed(() =>
    scanRoots.value.filter((root) => folderErrors.value[root] !== undefined),
  );

  function worktreesOf(path: string): IndexEntry[] {
    return worktrees.value.filter((entry) => entry.parentPath === path).sort(byName);
  }

  function folderCounts(root: string): FolderCounts {
    let repositories = 0;
    let found = 0;
    for (const entry of entries.value) {
      if (entry.scanRoot === null || !sameFolder(entry.scanRoot, root)) continue;
      if (entry.kind === "main") repositories += 1;
      else found += 1;
    }
    return { repositories, worktrees: found };
  }

  function find(path: string): IndexEntry | undefined {
    return entries.value.find((entry) => entry.path === path);
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

  function report(error: unknown): void {
    const failed = toAppError(error);
    const text = errorText(failed);
    toasts.push({
      kind: "error",
      message: i18n.global.t(text.key, text.params),
      output: failed.detail,
    });
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

  /** The settings' spelling of a folder a scan message names, or the message's own. */
  function settingsFolder(folder: string): string {
    return scanRoots.value.find((root) => sameFolder(root, folder)) ?? folder;
  }

  function withFolder(
    progress: ScanProgress,
    folder: string,
    state: FolderScanState,
  ): ScanProgress {
    return { ...progress, folders: { ...progress.folders, [folder]: state } };
  }

  function clearFolderError(folder: string): void {
    if (folderErrors.value[folder] === undefined) return;
    folderErrors.value = Object.fromEntries(
      Object.entries(folderErrors.value).filter(([key]) => key !== folder),
    );
  }

  function apply(message: ScanMessage): void {
    const current = scan.value;
    if (current.kind !== "scanning") return;
    switch (message.kind) {
      case "folder-started": {
        const folder = settingsFolder(message.folder);
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
        break;
      case "updated":
        upsert(message.entry);
        break;
      case "folder-done": {
        const folder = settingsFolder(message.folder);
        scan.value = withFolder(current, folder, "done");
        clearFolderError(folder);
        markMissing(message.missing);
        break;
      }
      case "folder-error": {
        const folder = settingsFolder(message.folder);
        scan.value = withFolder(current, folder, "error");
        folderErrors.value = { ...folderErrors.value, [folder]: { reason: message.reason } };
        break;
      }
    }
  }

  /** Folders asked for while a scan runs: queued in its folder states, scanned when it ends. */
  let queued: string[] = [];

  /**
   * Scans `folders` (every scan folder by default) with the settings' skip list and depth,
   * applying the messages as they arrive. While a scan runs, the folders it does not cover
   * wait for it and are scanned once it ends; the ones it covers are left alone.
   */
  function startScan(folders: string[] = scanRoots.value): void {
    if (folders.length === 0) return;
    const running = scan.value;
    if (running.kind === "scanning") {
      const waiting = folders.filter(
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
    for (const folder of folders) states[folder] = "queued";
    scan.value = { kind: "scanning", folders: states, scanned: 0, found: 0, current: null };
    scanError.value = null;
    const opId = newOpId("scan");
    operations.start(opId, "operations.scanning");
    const handle = ipc.scanFolders(
      folders,
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
        // The folders that waited, unless removed meanwhile.
        const next = queued.filter((folder) =>
          scanRoots.value.some((root) => sameFolder(root, folder)),
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

  /** Adds a scan folder and scans it; false when it was already listed. */
  function addRoot(path: string): boolean {
    if (scanRoots.value.some((root) => sameFolder(root, path))) return false;
    void settings.update("scanRoots", [...scanRoots.value, path]);
    startScan([path]);
    return true;
  }

  /** Removes a scan folder and the entries found under it (pinned and opened ones stay). */
  async function removeRoot(path: string): Promise<void> {
    void settings.update(
      "scanRoots",
      scanRoots.value.filter((root) => !sameFolder(root, path)),
    );
    clearFolderError(path);
    entries.value = entries.value.filter(
      (entry) => entry.scanRoot === null || !sameFolder(entry.scanRoot, path),
    );
    try {
      await ipc.removeScanRoot(path);
    } catch (error) {
      report(error);
    }
    await load();
  }

  /** Pins or unpins an entry at once; a refusal reverts it and shows a toast. */
  async function pin(path: string, pinned: boolean): Promise<void> {
    const before = find(path);
    if (!before) return;
    patch(path, { pinned });
    try {
      await ipc.pinRepository(path, pinned);
    } catch (error) {
      patch(path, { pinned: before.pinned });
      report(error);
    }
  }

  /** Forgets an entry (and a repository's worktrees) until a scan finds it again. */
  async function forget(path: string): Promise<void> {
    entries.value = entries.value.filter(
      (entry) => entry.path !== path && entry.parentPath !== path,
    );
    try {
      await ipc.forgetRepository(path);
    } catch (error) {
      report(error);
      await load();
    }
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
   * Adds the repository or worktree at `path` to the index without opening it ("Add
   * repository…"): the entry the backend stores, spelled as the index spells it, or why it
   * could not (`repo.not_found` for a folder that lies in no repository).
   */
  async function add(path: string): Promise<IndexEntry | AppError> {
    try {
      const entry = await ipc.refreshRepository(path, true);
      upsert(entry);
      return entry;
    } catch (error) {
      return toAppError(error);
    }
  }

  /**
   * Opens the repository at `path` through the repository store: the open is recorded first,
   * then the listing is synced with what the backend stored. A folder that is gone leaves the
   * shell in its error state and flags the entry.
   */
  async function open(path: string): Promise<void> {
    const repo = useRepoStore();
    patch(path, { lastOpenedAt: nowSeconds() });
    try {
      await ipc.recordRepositoryOpen(path);
    } catch {
      // The recents order is not worth refusing the open.
    }
    await repo.open(path);
    await afterOpen(path);
  }

  /**
   * Opens a folder the user picked or dropped: the repository it lies in, or, when it lies in
   * none, the folder as a scan folder (scanned again when it is one already). Resolves with
   * what it was, so the caller shows a folder's view. An indexed entry goes through `open`,
   * where the same answer means that its folder is gone.
   */
  async function openFolder(path: string): Promise<"repository" | "folder"> {
    const repo = useRepoStore();
    await repo.open(path);
    if (repo.state.kind === "error" && repo.state.error.code === "repo.not_found") {
      await repo.close();
      if (!addRoot(path)) startScan([path]);
      return "folder";
    }
    await afterOpen(path);
    return "repository";
  }

  /**
   * Reopens the last repository at launch. Resolves with null when it opened; otherwise the
   * shell returns to the home screen with the entry flagged and the error is returned.
   */
  async function restore(path: string): Promise<AppError | null> {
    const repo = useRepoStore();
    await repo.open(path);
    await afterOpen(path);
    if (repo.state.kind !== "error") return null;
    const failed = repo.state.error;
    await repo.close();
    return failed;
  }

  /**
   * Syncs the listing after an open. The backend records the open and refreshes the entry
   * off the open's critical path, so a repository opened from outside the index may not be
   * listed yet: it is asked for on its own, and its recents position is set here and now.
   */
  async function afterOpen(path: string): Promise<void> {
    const repo = useRepoStore();
    if (repo.state.kind === "ready") {
      const root = repo.repo?.root ?? path;
      await load();
      if (!find(root)) await refresh(root, false);
      patch(root, { lastOpenedAt: nowSeconds() });
    } else if (repo.state.kind === "error" && repo.state.error.code === "repo.not_found") {
      markMissing([path]);
      // The backend flags the entry too, so the mark survives the next listing.
      void ipc.refreshRepository(path, false).catch(() => undefined);
    }
  }

  // Back on the home screen, the listing is read again: the summary the backend refreshed
  // while the repository was open lands without a scan.
  watch(
    () => useRepoStore().state.kind,
    (kind, previous) => {
      if (kind === "empty" && previous !== undefined && previous !== "empty") void load();
    },
  );

  // The open repository's dirty flag is left alone while it is open (the home table, the only
  // place that shows it, shows no open repository); it is read once when the repository stops
  // being the open one. Back home, the listing read on the way may land after that refresh and
  // hold the flag from before it, so the listing is read once more after it.
  watch(
    () => useRepoStore().repo?.root,
    (now, before) => {
      if (before === undefined || before === now) return;
      void refresh(before, true).then(() => {
        if (useRepoStore().state.kind === "empty") return load();
      });
    },
  );

  /** Sorts the table by `column`; the same column again flips the direction. */
  function setSort(column: SortColumn): void {
    if (sort.value.column === column) {
      sort.value = { column, direction: sort.value.direction === "asc" ? "desc" : "asc" };
    } else {
      sort.value = { column, direction: defaultDirections[column] };
    }
  }

  return {
    entries,
    loaded,
    loading,
    loadError,
    scan,
    scanError,
    folderErrors,
    failedFolders,
    sort,
    isScanning,
    lastScanAt,
    scanRoots,
    mains,
    worktrees,
    pinned,
    recent,
    all,
    counts,
    worktreesOf,
    folderCounts,
    find,
    load,
    startScan,
    stopScan,
    addRoot,
    removeRoot,
    pin,
    forget,
    refresh,
    add,
    open,
    openFolder,
    restore,
    setSort,
  };
});
