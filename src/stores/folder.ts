// The project view and the folder view: the repositories and
// worktrees of a source, either the ones the scan found in one folder (the index entries whose
// scan folder it is, in path order) or a project's members (in its order, a missing one left
// to the Overview), a changes model each (`changesModel.ts`), the open repository's being the
// changes screen's store, the sections of those with changes, the group of those without, and
// the repository the selection is in. The view that shows (`ProjectLayout`) says when: its two
// tabs share the one set of models, reads and watchers. The reads wait in one queue
// and run two at a time: the first loads, the refresh button, the window's focus (at most every
// 5 seconds) and each return to the view. While the view shows, its repositories have watchers
// (`watch_folder`, up to 20), whose changes reach each model at most once a second (`pace.ts`).
// A repository's engine closes once its lists are read, but the one the selection is in and the
// open repository's (an engine keeps the index loaded, and twenty large ones would hold
// gigabytes). Leaving the view stops the watchers and closes the engines of the
// repositories that are not the open one; the models, their drafts included, stay while the
// folder does.

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
import type { AppError } from "@/ipc/errors";
import type { IndexEntry, RepoChanged } from "@/ipc/schemas";
import { sameFolder } from "@/shell/format";

import { useChangesStore } from "./changes";
import { createChangesModel, type ChangesView } from "./changesModel";
import { useIndexStore } from "./index";
import { Pacer } from "./pace";
import { useProjectsStore, type ProjectMember } from "./projects";
import { useRepoStore } from "./repo";
import { useSettingsStore, type ProjectTab } from "./settings";
import { useShellStore } from "./shell";

/**
 * Repositories whose lists are read at once. Each working-tree list runs a `git status` that
 * walks the tree, so large repositories contend for the disk: two at a time show the first one
 * twice as soon as four do, and all of them as soon.
 */
export const LOADS_AT_ONCE = 2;
/** A repository's watcher changes reach its lists at most this often. */
export const PACE_MS = 1000;
/** The window's focus reads every repository again at most this often. */
export const FOCUS_REFRESH_MS = 5000;

/** What the view shows: a scan folder's repositories, or a project's members. */
export type ViewSource = { kind: "folder"; path: string } | { kind: "project"; id: number };

function sameSource(a: ViewSource, b: ViewSource): boolean {
  if (a.kind === "folder" && b.kind === "folder") return sameFolder(a.path, b.path);
  return a.kind === "project" && b.kind === "project" && a.id === b.id;
}

/** A repository of the view, as its section and the group show it. */
export interface FolderRepository {
  root: string;
  /** Its path under the folder, with `/` separators; a project member's name. */
  name: string;
  /** Its branch as the index knows it; null when detached or unknown. */
  branch: string | null;
  /** Whether its HEAD is detached, as the index knows it. */
  detached: boolean;
  view: ChangesView;
}

/**
 * What the view shows: the scan (or the index) looking, no repository, the index or the
 * folder's scan failing, the first reads, sections, or nothing to commit.
 */
export type FolderState = "scanning" | "empty" | "error" | "loading" | "changes" | "clean";

/** Why the view shows no repository: the index did not load, or the folder's scan failed. */
export type FolderProblem = { kind: "index"; error: AppError } | { kind: "folder"; reason: string };

interface Member {
  root: string;
  view: ChangesView;
  scope: EffectScope;
}

/** A read waiting its turn: a first load, or both lists again. */
type Read = "load" | "reload";

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
  const projects = useProjectsStore();
  const openChanges = useChangesStore();

  /**
   * The source whose models the store holds: set when a view shows, kept when it leaves (the
   * drafts stay while the source does), replaced when a view of another source shows.
   */
  const source = ref<ViewSource | null>(null);
  /** The source the layout mode asks for: the active project, or the folder view's folder. */
  function wantedSource(): ViewSource | null {
    if (shell.layoutMode === "project") {
      const id = settings.values.activeProject;
      return id === null ? null : { kind: "project", id };
    }
    const path = settings.values.folderView;
    return path === null ? null : { kind: "folder", path };
  }
  const folder = computed(() => (source.value?.kind === "folder" ? source.value.path : null));
  /** The project shown; null for a folder, or a project the list does not hold (yet). */
  const project = computed(() =>
    source.value?.kind === "project" ? (projects.find(source.value.id) ?? null) : null,
  );
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

  const isOpen = (root: string) => {
    const open = repo.repo?.root;
    return open !== undefined && sameFolder(open, root);
  };

  /**
   * Every member of the source in its order, as the Overview lists them: a folder's entries
   * named by their path under it, a project's members with the missing ones.
   */
  const listed = computed<ProjectMember[]>(() => {
    const current = source.value;
    if (current === null) return [];
    if (current.kind === "project") return project.value ? projects.members(project.value) : [];
    return index.entries
      .filter(
        (entry) =>
          entry.scanRoot !== null && sameFolder(entry.scanRoot, current.path) && !entry.missing,
      )
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((entry) => ({
        path: entry.path,
        entry,
        missing: false,
        name: pathUnder(current.path, entry.path),
      }));
  });

  /** The members that are there, in the source's order: the ones with models and watchers. */
  const present = computed(() => listed.value.filter((member) => !member.missing && member.entry));

  /** Their index entries. */
  const entries = computed<IndexEntry[]>(() =>
    present.value.flatMap((member) => (member.entry ? [member.entry] : [])),
  );

  const repositories = computed<FolderRepository[]>(() =>
    present.value.flatMap((listedMember) => {
      const entry = listedMember.entry;
      const member = entry ? members.get(entry.path) : undefined;
      if (!entry || !member) return [];
      return [
        {
          root: entry.path,
          name: listedMember.name,
          branch: entry.summary.currentBranch,
          detached: entry.summary.detached,
          // One draft and one read of the open repository: the changes screen's.
          view: isOpen(entry.path) ? openChanges : member.view,
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

  /** The changes model of `root`: the changes screen's for the open repository. */
  function viewOf(root: string): ChangesView | null {
    if (isOpen(root)) return openChanges;
    return members.get(root)?.view ?? null;
  }

  /** Whether the scan walks the folder or waits to. */
  const scanning = computed(() => {
    const scan = index.scan;
    const current = folder.value;
    if (scan.kind !== "scanning" || current === null) return false;
    return Object.entries(scan.folders).some(
      ([known, state]) =>
        sameFolder(known, current) && (state === "queued" || state === "scanning"),
    );
  });

  const problem = computed<FolderProblem | null>(() => {
    if (index.loadError) return { kind: "index", error: index.loadError };
    const current = folder.value;
    if (current === null) return null;
    const failed = Object.entries(index.folderErrors).find(([known]) => sameFolder(known, current));
    return failed ? { kind: "folder", reason: failed[1].reason } : null;
  });

  const state = computed<FolderState>(() => {
    if (entries.value.length === 0) {
      const listing = source.value?.kind === "project" && !projects.loaded;
      if (!index.loaded || listing || scanning.value) return "scanning";
      return problem.value ? "error" : "empty";
    }
    if (sections.value.length > 0) return "changes";
    if (checking.value.length > 0) return "loading";
    return scanning.value ? "scanning" : "clean";
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
          // The index learns the new tip.
          onCommitted: () => void index.refresh(root, false),
        }),
      ),
    );
    if (!view) throw new Error("the changes model was not made");
    return { root, view, scope };
  }

  /**
   * Closes the engine of `target` once its lists are read and no write runs, unless it is the
   * open repository or, while the view shows it, the one the selection is in: an engine keeps
   * its repository's index loaded (about a hundred megabytes on a tree of 50,000 files), and
   * the next read opens it again. A model the view dropped (another folder shows) or a view that
   * left closes it too.
   */
  async function release(target: Member): Promise<void> {
    await target.view.settled();
    // The counts, and with them the sections and the active repository, follow the lists.
    await nextTick();
    if (isOpen(target.root)) return;
    const current = members.get(target.root) === target;
    if (shown.value && current && active.value?.root === target.root) return;
    if (target.view.busy !== null) {
      // The write reads its lists again: the engine goes once they are read.
      const stop = watch(
        () => target.view.busy,
        (busy) => {
          if (busy !== null) return;
          stop();
          void release(target);
        },
      );
      return;
    }
    await ipc.closeRepository(target.root).catch(() => undefined);
  }

  /** The reads waiting their turn, in the order asked, a repository once. */
  const queue = new Map<string, Read>();
  let running = 0;

  function enqueue(root: string, read: Read): void {
    // A first load reads both lists anyway.
    if (queue.get(root) !== "load") queue.set(root, read);
    pump();
  }

  /** Runs the reads that wait, two at a time, the first asked first. */
  function pump(): void {
    while (shown.value && running < LOADS_AT_ONCE && queue.size > 0) {
      const [root, read] = queue.entries().next().value ?? [];
      if (root === undefined || read === undefined) return;
      queue.delete(root);
      const next = members.get(root);
      // The open repository's lists are the changes screen's, read there.
      if (!next || isOpen(root)) continue;
      running += 1;
      if (read === "load" || !next.view.loaded) {
        next.view.load();
      } else {
        next.view.requestReload("unstaged", { kind: "full" });
        next.view.requestReload("staged", { kind: "full" });
      }
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
      drop(gone);
    }
    for (const entry of entries.value) {
      if (members.has(entry.path)) continue;
      members.set(entry.path, member(entry.path));
      enqueue(entry.path, "load");
    }
  }

  /** Drops the model of `gone`; its engine closes once its reads end. */
  function drop(gone: Member): void {
    members.delete(gone.root);
    queue.delete(gone.root);
    void release(gone);
    gone.scope.stop();
  }

  /** Drops every model: another folder shows. */
  function disposeAll(): void {
    for (const gone of [...members.values()]) drop(gone);
    activeRoot.value = null;
    collapsed.clear();
    groupOpen.value = false;
  }

  /** Reads the lists of `root` again (after a bulk operation wrote to it). */
  function reload(root: string): void {
    if (isOpen(root)) {
      openChanges.requestReload("unstaged", { kind: "full" });
      openChanges.requestReload("staged", { kind: "full" });
    } else if (members.has(root)) {
      enqueue(root, "reload");
    }
  }

  /** Reads every repository's lists again (the refresh button, the window's focus, a return). */
  function refresh(): void {
    for (const current of members.values()) {
      if (isOpen(current.root)) {
        openChanges.requestReload("unstaged", { kind: "full" });
        openChanges.requestReload("staged", { kind: "full" });
      } else {
        enqueue(current.root, "reload");
      }
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
    if (!target || isOpen(target.root)) return;
    target.view.onRepoChanged(change);
    // The section's branch and the box's line come from the index entry.
    if (change.kinds.includes("refs") || change.kinds.includes("worktrees")) {
      void index.refresh(target.root, false);
    }
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
      // The open repository's changes reach the changes screen's store, not this pacer.
      stop = await onRepoChanged((change) => {
        if (memberOf(change) && !isOpen(change.repo)) pacer.push(change);
      });
    } catch {
      // Outside Tauri there is nothing to listen to.
      return;
    }
    if (shown.value) unlisten = stop;
    else stop();
  }

  /** Holds the models of `next`, another source's making way; false when it already did. */
  function adopt(next: ViewSource | null): boolean {
    if (next === null) return false;
    if (source.value !== null && sameSource(source.value, next)) return false;
    if (source.value !== null) disposeAll();
    source.value = next;
    return true;
  }

  /** The view comes on screen: models, events, the window's focus, and a fresh read. */
  function show(): void {
    adopt(wantedSource());
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
    queue.clear();
    window.removeEventListener("focus", onFocus);
    watched.value = [];
    void ipc.unwatchFolder().catch(() => undefined);
    for (const root of members.keys()) {
      if (!isOpen(root)) void ipc.closeRepository(root).catch(() => undefined);
    }
  }

  /** Shows the view of `path` on `tab` (its changes by default), another source's models making way. */
  async function open(path: string, tab: ProjectTab = "changes"): Promise<void> {
    // The settings change at once and reach the disk together, so the view shows at once.
    const writes: Promise<void>[] = [];
    const shownFolder = settings.values.folderView;
    if (shownFolder === null || !sameFolder(shownFolder, path)) {
      writes.push(settings.update("folderView", path));
    }
    if (settings.values.projectTab !== tab) writes.push(settings.update("projectTab", tab));
    writes.push(shell.setLayoutMode("folder"));
    adopt(wantedSource());
    await Promise.all(writes);
  }

  /** Opens the repository at `root` in graph focus (a section's "Open repository"). */
  async function openRepository(root: string): Promise<void> {
    await index.open(root);
    await shell.setLayoutMode("graph");
  }

  /** Looks for the folder's repositories again, as a scan folder of Home once more if needed. */
  function scanAgain(): void {
    const current = folder.value;
    if (current !== null && !index.addRoot(current)) index.startScan([current]);
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
  // Another project or folder while the view shows (the palette, "Save as project"): its
  // models replace the ones held, read at once.
  watch(
    () => JSON.stringify(wantedSource()),
    () => {
      if (!shown.value || !adopt(wantedSource())) return;
      sync();
    },
  );
  // A repository that stops being the open one shows its own model again, read afresh.
  watch(
    () => repo.repo?.root ?? null,
    (_now, before) => {
      if (before === null) return;
      const left = [...members.values()].find((candidate) => sameFolder(candidate.root, before));
      if (left && shown.value) enqueue(left.root, "reload");
    },
  );
  // The repository the selection enters gets its box's context; the one it leaves lets its
  // engine go.
  watch(
    () => active.value?.root ?? null,
    (now, before) => {
      const entered = active.value;
      if (now !== null && entered && entered.view.context === null) {
        void entered.view.loadContext();
      }
      const left = before === null ? undefined : members.get(before);
      if (left) void release(left);
    },
  );

  return {
    source,
    folder,
    project,
    shown,
    listed,
    repositories,
    sections,
    clean,
    checking,
    scanning,
    problem,
    state,
    active,
    collapsed,
    groupOpen,
    watched,
    viewOf,
    activate,
    toggleSection,
    toggleGroup,
    refresh,
    reload,
    show,
    hide,
    open,
    openRepository,
    scanAgain,
  };
});
