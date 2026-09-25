// The folder view: the repositories and worktrees the scan found in one folder
// (the index entries whose scan folder it is), a changes model each (`changesModel.ts`) loaded
// two at a time, the sections of those with changes, the group of those without, and the
// repository the selection is in. While the view shows, its repositories have watchers
// (`watch_folder`, up to 20), whose changes reach each model at most once a second (`pace.ts`),
// and the window's focus reads every model again, at most every 5 seconds. A repository's engine
// closes once its lists are read, but the one the selection is in and the open repository's
// (an engine keeps the index loaded, and twenty large ones would hold gigabytes). Leaving the
// view stops the watchers and closes the engines of the repositories
// that are not the open one; the models, their drafts included, stay while the folder does.

import type { UnlistenFn } from "@tauri-apps/api/event";
import { defineStore } from "pinia";
import {
  computed,
  effectScope,
  nextTick,
  reactive,
  ref,
  shallowReactive,
  watch,
  type EffectScope,
} from "vue";

import * as ipc from "@/ipc/commands";
import { onRepoChanged } from "@/ipc/events";
import type { IndexEntry, RepoChanged } from "@/ipc/schemas";
import { sameFolder } from "@/shell/format";

import { createChangesModel, type ChangesView } from "./changesModel";
import { useIndexStore } from "./index";
import { Pacer } from "./pace";
import { useRepoStore } from "./repo";
import { useSettingsStore } from "./settings";
import { useShellStore } from "./shell";

/**
 * Repositories whose lists load at once. Each working-tree list runs a `git status` that walks
 * the tree, so large repositories contend for the disk: two at a time show the first one twice
 * as soon as four do, and all of them as soon.
 */
export const LOADS_AT_ONCE = 2;
/** A repository's watcher changes reach its lists at most this often. */
export const PACE_MS = 1000;
/** The window's focus reads every repository again at most this often. */
export const FOCUS_REFRESH_MS = 5000;

/** A repository of the view, as its section and the group show it. */
export interface FolderRepository {
  root: string;
  /** Its path under the folder, with `/` separators. */
  name: string;
  /** Its branch as the index knows it; null when detached or unknown. */
  branch: string | null;
  view: ChangesView;
}

/** What the view shows: the scan looking, no repository, the first reads, sections, or none. */
export type FolderState = "scanning" | "empty" | "loading" | "changes" | "clean";

interface Member {
  root: string;
  view: ChangesView;
  scope: EffectScope;
}

/** `path` under `folder`, with `/` separators; the whole path when it is not under it. */
export function pathUnder(folder: string, path: string): string {
  const norm = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = `${norm(folder)}/`;
  const full = norm(path);
  return full.toLowerCase().startsWith(base.toLowerCase()) ? full.slice(base.length) : full;
}

export const useFolderStore = defineStore("folder", () => {
  const settings = useSettingsStore();
  const index = useIndexStore();
  const repo = useRepoStore();
  const shell = useShellStore();

  const folder = computed(() => settings.values.folderView);
  /** Whether the view is on screen: the watchers, the events and the focus follow it. */
  const shown = ref(false);
  const members = shallowReactive(new Map<string, Member>());
  const activeRoot = ref<string | null>(null);
  /** The sections closed from their header. */
  const collapsed = reactive(new Set<string>());
  /** Whether the group of repositories without changes is open. */
  const groupOpen = ref(false);
  /** The roots the folder watchers watch, as `watch_folder` answered. */
  const watched = ref<string[]>([]);

  /** The folder's index entries, missing ones left out, in path order. */
  const entries = computed<IndexEntry[]>(() => {
    const current = folder.value;
    if (current === null) return [];
    return index.entries
      .filter(
        (entry) => entry.scanRoot !== null && sameFolder(entry.scanRoot, current) && !entry.missing,
      )
      .sort((a, b) => a.path.localeCompare(b.path));
  });

  const repositories = computed<FolderRepository[]>(() =>
    entries.value.flatMap((entry) => {
      const member = members.get(entry.path);
      if (!member) return [];
      return [
        {
          root: entry.path,
          name: pathUnder(folder.value ?? "", entry.path),
          branch: entry.summary.currentBranch,
          view: member.view,
        },
      ];
    }),
  );

  const withChanges = (repository: FolderRepository) =>
    repository.view.error !== null || (repository.view.counts?.changed ?? 0) > 0;
  /** The repositories with changes (or whose lists failed): the sections, in path order. */
  const sections = computed(() => repositories.value.filter(withChanges));
  /** The repositories whose lists are read and hold nothing. */
  const clean = computed(() =>
    repositories.value.filter(
      (repository) => !withChanges(repository) && repository.view.counts !== null,
    ),
  );
  /** The repositories not read yet. */
  const checking = computed(() =>
    repositories.value.filter(
      (repository) => !withChanges(repository) && repository.view.counts === null,
    ),
  );

  /** Whether the scan is walking the folder or waits to. */
  const scanning = computed(() => {
    const scan = index.scan;
    const current = folder.value;
    if (scan.kind !== "scanning" || current === null) return false;
    return Object.entries(scan.folders).some(
      ([known, state]) =>
        sameFolder(known, current) && (state === "queued" || state === "scanning"),
    );
  });

  const state = computed<FolderState>(() => {
    if (entries.value.length === 0) return scanning.value ? "scanning" : "empty";
    if (sections.value.length > 0) return "changes";
    return checking.value.length > 0 ? "loading" : "clean";
  });

  /** The repository the selection is in, else the first section's. */
  const active = computed<FolderRepository | null>(() => {
    const chosen = sections.value.find((repository) => repository.root === activeRoot.value);
    return chosen ?? sections.value[0] ?? null;
  });

  function activate(root: string): void {
    activeRoot.value = root;
  }

  function toggleSection(root: string): void {
    if (collapsed.has(root)) collapsed.delete(root);
    else collapsed.add(root);
  }

  function toggleGroup(): void {
    groupOpen.value = !groupOpen.value;
  }

  // --- Models ---------------------------------------------------------------------------------

  function member(root: string): Member {
    const scope = effectScope(true);
    const view = scope.run(() =>
      reactive(
        createChangesModel({
          root: () => root,
          onCommitted: () => {
            // The index learns the new tip; the open repository's graph lists it.
            void index.refresh(root, false);
            if (repo.repo?.root === root) repo.restartWalk(repo.walkScope, repo.walkFilter);
          },
        }),
      ),
    );
    if (!view) throw new Error("the changes model was not made");
    return { root, view, scope };
  }

  const isOpen = (root: string) => {
    const open = repo.repo?.root;
    return open !== undefined && sameFolder(open, root);
  };

  /**
   * Closes the engine of `target` once its lists are read, unless the selection is in it or it
   * is the open repository: an engine keeps its repository's index loaded (about a hundred
   * megabytes on a tree of 50,000 files), and the next read opens it again.
   */
  async function release(target: Member): Promise<void> {
    await target.view.settled();
    // The counts, and with them the sections and the active repository, follow the lists.
    await nextTick();
    if (!shown.value || members.get(target.root) !== target) return;
    if (target.view.busy !== null || active.value?.root === target.root || isOpen(target.root)) {
      return;
    }
    await ipc.closeRepository(target.root).catch(() => undefined);
  }

  const queue: string[] = [];
  let running = 0;

  /** Loads the models that wait, four at a time, the first in path order first. */
  function pump(): void {
    while (running < LOADS_AT_ONCE && queue.length > 0) {
      const root = queue.shift();
      const next = root === undefined ? undefined : members.get(root);
      if (!next) continue;
      running += 1;
      next.view.load();
      void next.view.settled().finally(() => {
        running -= 1;
        void release(next);
        pump();
      });
    }
  }

  /** One model per repository of the folder; the new ones load, the gone ones go. */
  function sync(): void {
    const roots = new Set(entries.value.map((entry) => entry.path));
    for (const [root, gone] of members) {
      if (roots.has(root)) continue;
      gone.scope.stop();
      members.delete(root);
    }
    for (const entry of entries.value) {
      if (members.has(entry.path)) continue;
      members.set(entry.path, member(entry.path));
      queue.push(entry.path);
    }
    pump();
  }

  /** Drops every model: another folder shows. */
  function disposeAll(): void {
    for (const gone of members.values()) gone.scope.stop();
    members.clear();
    queue.length = 0;
    activeRoot.value = null;
    collapsed.clear();
    groupOpen.value = false;
  }

  /** Reads every repository's lists again (the refresh button, the window's focus). */
  function refresh(): void {
    for (const current of members.values()) {
      current.view.requestReload("unstaged", { kind: "full" });
      current.view.requestReload("staged", { kind: "full" });
      void release(current);
    }
  }

  // --- On screen ------------------------------------------------------------------------------

  /** The model of the repository a change names, spelled as the engine spells it. */
  function memberOf(change: RepoChanged): Member | undefined {
    const exact = members.get(change.repo);
    if (exact) return exact;
    for (const [root, candidate] of members) {
      if (sameFolder(root, change.repo)) return candidate;
    }
    return undefined;
  }

  const pacer = new Pacer(PACE_MS, (change) => {
    const target = memberOf(change);
    if (!target) return;
    target.view.onRepoChanged(change);
    void release(target);
  });
  let unlisten: UnlistenFn | null = null;
  let lastFocusRefresh = Number.NEGATIVE_INFINITY;

  function onFocus(): void {
    if (Date.now() - lastFocusRefresh < FOCUS_REFRESH_MS) return;
    lastFocusRefresh = Date.now();
    refresh();
  }

  async function listen(): Promise<void> {
    let stop: UnlistenFn;
    try {
      stop = await onRepoChanged((change) => {
        if (memberOf(change)) pacer.push(change);
      });
    } catch {
      // Outside Tauri there is nothing to listen to.
      return;
    }
    if (shown.value) unlisten = stop;
    else stop();
  }

  /** The view comes on screen: models, events, the window's focus, and a fresh read. */
  function show(): void {
    if (shown.value) return;
    shown.value = true;
    refresh();
    sync();
    void listen();
    window.addEventListener("focus", onFocus);
  }

  /** The view leaves the screen: its watchers stop and the engines it opened close. */
  function hide(): void {
    if (!shown.value) return;
    shown.value = false;
    unlisten?.();
    unlisten = null;
    pacer.clear();
    window.removeEventListener("focus", onFocus);
    watched.value = [];
    void ipc.unwatchFolder().catch(() => undefined);
    for (const root of members.keys()) {
      if (!isOpen(root)) void ipc.closeRepository(root).catch(() => undefined);
    }
  }

  /** Shows the view of `path`, another folder's models making way. */
  async function open(path: string): Promise<void> {
    if (folder.value === null || !sameFolder(folder.value, path)) {
      disposeAll();
      await settings.update("folderView", path);
    }
    await shell.setLayoutMode("folder");
  }

  /** Looks for the folder's repositories again (the empty view's button). */
  function scanAgain(): void {
    if (folder.value !== null) index.startScan([folder.value]);
  }

  // New and gone repositories while the view shows; the watchers follow them and the open
  // repository, which keeps its own.
  watch(
    () => [shown.value, entries.value.map((entry) => entry.path).join("\n")] as const,
    ([isShown]) => {
      if (isShown) sync();
    },
  );
  watch(
    () =>
      [shown.value, entries.value.map((entry) => entry.path).join("\n"), repo.repo?.root] as const,
    ([isShown, key]) => {
      if (!isShown) return;
      const roots = key === "" ? [] : key.split("\n");
      void ipc
        .watchFolder(roots)
        .then((list) => {
          if (shown.value) watched.value = list;
        })
        .catch(() => {
          watched.value = [];
        });
    },
  );
  watch(folder, (now, before) => {
    if (before !== undefined && now !== before) disposeAll();
  });
  // The repository the selection leaves lets its engine go.
  watch(
    () => active.value?.root ?? null,
    (_now, before) => {
      const left = before === null ? undefined : members.get(before);
      if (left) void release(left);
    },
  );

  return {
    folder,
    shown,
    repositories,
    sections,
    clean,
    checking,
    state,
    active,
    collapsed,
    groupOpen,
    watched,
    activate,
    toggleSection,
    toggleGroup,
    refresh,
    show,
    hide,
    open,
    scanAgain,
  };
});
