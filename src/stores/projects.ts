// Projects: the unit the app opens. A folder project holds what the scans of its
// folder find, then any repository added to it by hand; a list project holds what was added to
// it. Every indexed repository belongs to one or more. The store keeps the list, the open
// project (`settings.activeProject`) and the repository it shows (the repository store's), each
// project's members resolved against the index (a path the index no longer lists, or whose
// folder is gone, is missing; none is while the index is not read), what needs attention on
// Home, and the neighbours for Alt ↓ and Alt ↑. Making, editing, pinning or deleting a project
// writes to no repository; the backend answers the repositories an edit or a deletion took out
// of the index (they belonged to no other project), and the index store drops them.

import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";

import { i18n } from "@/i18n";
import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type { IndexEntry, MemberOrigin, OperationState, Project, ProjectEdit } from "@/ipc/schemas";
import { errorText } from "@/shell/errorMessage";
import { baseName, folderKey, isUnder, pathUnder, sameFolder } from "@/shell/format";

import { useIndexStore } from "./index";
import { useOperationsStore } from "./operations";
import { useProjectDialogsStore } from "./projectDialogs";
import { useRepoStore } from "./repo";
import { useSettingsStore, type LegacySettings } from "./settings";
import { useShellStore } from "./shell";
import { useToastsStore } from "./toasts";

/** A project's member as the Overview, the Repos tab, the selector and the dialogs show it. */
export interface ProjectMember {
  path: string;
  /** Its index entry; null when the index does not list the path. */
  entry: IndexEntry | null;
  /** No index entry, or a folder the index found gone; never while the index is not read. */
  missing: boolean;
  /** Its path under the folder for a folder project's own member; otherwise the entry's name
   * (the folder's without one), with its parent folder when another member shares it. */
  name: string;
  origin: MemberOrigin;
  /** A worktree listed under its repository, which is a member too. */
  nested: boolean;
}

/** What Home's line of a project counts. */
export interface ProjectAttention {
  changes: number;
  behind: number;
  /** Members in the middle of each kind of operation. */
  operations: Partial<Record<Exclude<OperationState, "none">, number>>;
  missing: number;
}

/** A folder project's own members by kind, as Home and the settings count them. */
export interface FolderCounts {
  repositories: number;
  worktrees: number;
}

/** Projects listed under Recent on Home and in the switcher. */
export const RECENT_PROJECTS = 5;

function byName(a: Project, b: Project): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id - b.id;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The folder `path` lies in, by name. */
function parentName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return at > 0 ? baseName(trimmed.slice(0, at)) : "";
}

/**
 * `members` with each worktree whose repository is a member too moved under it, flagged
 * nested; the rest keep their order.
 */
export function nestWorktrees(members: readonly ProjectMember[]): ProjectMember[] {
  const keys = new Set(members.map((member) => folderKey(member.path)));
  const parentOf = (member: ProjectMember): string | null => {
    const parent = member.entry?.kind === "worktree" ? member.entry.parentPath : null;
    if (parent === null) return null;
    const key = folderKey(parent);
    return keys.has(key) && key !== folderKey(member.path) ? key : null;
  };
  const children = new Map<string, ProjectMember[]>();
  for (const member of members) {
    const parent = parentOf(member);
    if (parent !== null) children.set(parent, [...(children.get(parent) ?? []), member]);
  }
  const nested: ProjectMember[] = [];
  for (const member of members) {
    if (parentOf(member) !== null) continue;
    nested.push({ ...member, nested: false });
    for (const child of children.get(folderKey(member.path)) ?? []) {
      nested.push({ ...child, nested: true });
    }
  }
  return nested;
}

/**
 * The members of `project` in its order against the index `entries`: each path with its entry
 * (spelled as the index spells it), missing when there is none or its folder is gone, each
 * worktree under its repository when both are members (unless `nest` is false: the edit
 * dialog keeps the stored order). Until the index is `read`, no member is missing: its entry
 * is only not known yet.
 */
export function resolveMembers(
  project: Pick<Project, "members" | "folder">,
  entries: readonly IndexEntry[] | ReadonlyMap<string, IndexEntry>,
  read = true,
  nest = true,
): ProjectMember[] {
  const byKey =
    entries instanceof Map
      ? entries
      : new Map((entries as readonly IndexEntry[]).map((entry) => [folderKey(entry.path), entry]));
  const folder = project.folder;
  const members = project.members.map((member): ProjectMember => {
    const entry = byKey.get(folderKey(member.path)) ?? null;
    const own = member.origin === "folder" && folder !== null;
    return {
      path: entry?.path ?? member.path,
      entry,
      missing: read && (entry === null || entry.missing),
      name: own ? pathUnder(folder, member.path) : (entry?.name ?? baseName(member.path)),
      origin: member.origin,
      nested: false,
    };
  });
  const counts = new Map<string, number>();
  for (const member of members) {
    const key = member.name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const named = members.map((member) =>
    member.origin !== "folder" && (counts.get(member.name.toLowerCase()) ?? 0) > 1
      ? { ...member, name: `${parentName(member.path)}/${member.name}` }
      : member,
  );
  return nest ? nestWorktrees(named) : named;
}

/** What needs attention among `members`: changes, behind, operations in progress, missing. */
export function attentionOf(members: readonly ProjectMember[]): ProjectAttention {
  const attention: ProjectAttention = { changes: 0, behind: 0, operations: {}, missing: 0 };
  for (const member of members) {
    if (member.missing) attention.missing += 1;
    if (member.missing || !member.entry) continue;
    const summary = member.entry.summary;
    if (summary.dirty === true) attention.changes += 1;
    if ((summary.behind ?? 0) > 0) attention.behind += 1;
    const operation = summary.operation;
    if (operation !== null && operation !== "none") {
      attention.operations[operation] = (attention.operations[operation] ?? 0) + 1;
    }
  }
  return attention;
}

/**
 * The member after (`step` 1) or before (-1) `current` in the project's order, the last
 * wrapping to the first, missing members skipped; the first (or last) present member when
 * `current` is not one of them. Null when no member is present, or `current` is the only one.
 */
export function neighbourOf(
  members: readonly ProjectMember[],
  current: string | null,
  step: 1 | -1,
): ProjectMember | null {
  const present = members.filter((member) => !member.missing && member.entry !== null);
  if (present.length === 0) return null;
  const at = current === null ? -1 : present.findIndex((m) => sameFolder(m.path, current));
  if (at < 0) return step === 1 ? (present[0] ?? null) : (present[present.length - 1] ?? null);
  if (present.length === 1) return null;
  return present[(at + step + present.length) % present.length] ?? null;
}

/** The project opened last among `candidates`; the first by name when none was opened. */
function openedLast(candidates: readonly Project[]): Project | undefined {
  return [...candidates].sort((a, b) => (b.openedAt ?? -1) - (a.openedAt ?? -1) || byName(a, b))[0];
}

export const useProjectsStore = defineStore("projects", () => {
  const settings = useSettingsStore();
  const index = useIndexStore();
  const shell = useShellStore();
  const repo = useRepoStore();
  const toasts = useToastsStore();
  const operations = useOperationsStore();

  // Replaced as a whole on every change: at most a few hundred, each a list of paths.
  const projects = shallowRef<Project[]>([]);
  const loaded = ref(false);
  const loadError = ref<AppError | null>(null);
  /** A folder project opened before its scan found a repository: it shows the first found. */
  let waitingFirst: number | null = null;

  const active = computed(
    () => projects.value.find((project) => project.id === settings.values.activeProject) ?? null,
  );

  function find(id: number): Project | undefined {
    return projects.value.find((project) => project.id === id);
  }

  /** The index entries by comparable path, read once per listing. */
  const entryMap = computed(
    () => new Map(index.entries.map((entry) => [folderKey(entry.path), entry])),
  );
  /** Every project's members, resolved once per change of the projects or the index. */
  const resolved = computed(
    () =>
      new Map(
        projects.value.map((project) => [
          project.id,
          resolveMembers(project, entryMap.value, index.read),
        ]),
      ),
  );

  function members(project: Pick<Project, "id" | "members" | "folder">): ProjectMember[] {
    const known = resolved.value.get(project.id);
    return known && find(project.id) === project
      ? known
      : resolveMembers(project, entryMap.value, index.read);
  }

  /** The open project's members; empty without one. */
  const activeMembers = computed(() => (active.value ? members(active.value) : []));
  /** Whether the open project holds more than one repository: the Overview and the folder
   * view's Changes are offered, and the graph shows the repository selector. */
  const multi = computed(() => (active.value?.members.length ?? 0) > 1);
  /** The view of the open project the layout shows: its Overview or its folder view. */
  const view = computed<"overview" | "changes" | null>(() => {
    const mode = shell.layoutMode;
    return multi.value && (mode === "overview" || mode === "changes") ? mode : null;
  });

  /** The repository the open project shows: the open one, or the one opening or failing. */
  const shownPath = computed(() => {
    const state = repo.state;
    if (state.kind === "ready") return repo.repo?.root ?? null;
    if (state.kind === "opening" || state.kind === "error") return state.path;
    return null;
  });

  /** Whether `path` is the repository the open project shows. */
  function isShown(path: string): boolean {
    const shown = shownPath.value;
    return shown !== null && sameFolder(shown, path);
  }

  /** Every project by name. */
  const sorted = computed(() => [...projects.value].sort(byName));
  /** The pinned projects, by name. */
  const pinned = computed(() => sorted.value.filter((project) => project.pinned));
  /** The last opened projects that are not pinned, newest first. */
  const recent = computed(() =>
    projects.value
      .filter((project) => project.openedAt !== null && !project.pinned)
      .sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0) || byName(a, b))
      .slice(0, RECENT_PROJECTS),
  );
  /** The folder projects' folders, by the projects' names. */
  const folders = computed(() =>
    sorted.value.flatMap((project) => (project.folder === null ? [] : [project.folder])),
  );

  function folderProjectOf(folder: string): Project | undefined {
    return projects.value.find(
      (project) => project.folder !== null && sameFolder(project.folder, folder),
    );
  }

  /** The projects holding `path`. */
  function holding(path: string): Project[] {
    return projects.value.filter((project) =>
      project.members.some((member) => sameFolder(member.path, path)),
    );
  }

  /** Of `paths`, the ones no project but `project` holds: they leave Begitra with it. */
  function leaving(project: Pick<Project, "id">, paths: readonly string[]): string[] {
    return paths.filter((path) => !holding(path).some((other) => other.id !== project.id));
  }

  /** A folder project's own members by kind; its members found so far during its scan. */
  function folderCounts(project: Project): FolderCounts {
    let repositories = 0;
    let worktrees = 0;
    for (const member of members(project)) {
      if (member.origin !== "folder") continue;
      if (member.entry?.kind === "worktree") worktrees += 1;
      else repositories += 1;
    }
    return { repositories, worktrees };
  }

  /** Runs `work` with the status bar's "Looking up <folder>": the disk may take its time. */
  async function lookingUp<T>(path: string, work: (opId: string) => Promise<T>): Promise<T> {
    const opId = newOpId("project-for-path");
    operations.start(opId, "operations.lookingUp", undefined, {
      params: { name: baseName(path) },
    });
    try {
      return await work(opId);
    } finally {
      operations.finish(opId);
    }
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

  function replace(project: Project): void {
    projects.value = [...projects.value.filter((known) => known.id !== project.id), project];
  }

  function patchProject(id: number, changes: Partial<Project>): void {
    const known = find(id);
    if (known) replace({ ...known, ...changes });
  }

  /** Lists the projects; a failure is kept in `loadError` and the list stays as it was. */
  async function load(): Promise<void> {
    try {
      projects.value = await ipc.listProjects();
      loadError.value = null;
    } catch (error) {
      loadError.value = toAppError(error);
    } finally {
      loaded.value = true;
    }
  }

  // --- Showing and opening --------------------------------------------------------------------

  /** Records that project `id` shows `path` (its recents and its last repository). */
  function remember(id: number, path: string | null): void {
    const changes: Partial<Project> = { openedAt: nowSeconds() };
    if (path !== null) changes.lastRepository = path;
    patchProject(id, changes);
    // The recents order is not worth refusing an open.
    void ipc.recordProjectOpen(id, path).catch(() => undefined);
  }

  /**
   * The repository `project` shows when it opens: the one it showed last, else its first; one
   * the index found gone is skipped, one it does not list is tried (the open tells).
   */
  function firstShown(project: Project): string | null {
    const usable = members(project).filter((member) => member.entry?.missing !== true);
    const last = project.lastRepository;
    const again = last === null ? undefined : usable.find((m) => sameFolder(m.path, last));
    return again?.path ?? usable[0]?.path ?? null;
  }

  /**
   * Shows `path`, a repository of the open project, and makes it the one the project shows
   * (the graph's selector, the Repos tab, the palette, Alt ↓, the Overview's ↵). The Overview
   * gives way to the graph; the other layouts stay.
   */
  async function show(path: string): Promise<void> {
    const project = active.value;
    if (project) remember(project.id, path);
    waitingFirst = null;
    if (shell.layoutMode === "overview") void shell.setLayoutMode("graph");
    if (repo.state.kind === "ready" && isShown(path)) return;
    await repo.open(path);
    await index.afterOpen(path);
  }

  /**
   * Opens project `id` in graph focus showing `repository`, else the one it showed last, else
   * its first; a project without a present repository shows its empty state (a folder
   * project's, until its scan finds one).
   */
  async function open(id: number, repository: string | null = null): Promise<void> {
    const project = find(id);
    if (!project) return;
    if (settings.values.activeProject !== id) void settings.update("activeProject", id);
    if (shell.layoutMode !== "graph") void shell.setLayoutMode("graph");
    const target = repository ?? firstShown(project);
    if (target === null) {
      remember(id, null);
      waitingFirst = project.kind === "folder" ? id : null;
      if (repo.state.kind !== "empty") await repo.close();
      return;
    }
    await show(target);
  }

  /** Makes (or finds) the folder project of `folder`, scans it and opens it. */
  async function openFolder(folder: string): Promise<Project | null> {
    let project: Project;
    try {
      project = await lookingUp(folder, () => ipc.createFolderProject(folder));
    } catch (error) {
      report(error);
      return null;
    }
    replace(project);
    // A folder opened again is scanned again.
    index.startScan([project.folder ?? folder]);
    await open(project.id);
    return project;
  }

  /**
   * Opens a folder the user picked or dropped: the project of the repository it lies in (the
   * one opened last, or a project of one made for it), showing that repository; a folder in no
   * repository opens its folder project, made and scanned the first time.
   */
  async function openPath(path: string): Promise<void> {
    let answer: Awaited<ReturnType<typeof ipc.projectForPath>>;
    try {
      answer = await lookingUp(path, (opId) => ipc.projectForPath(path, opId));
    } catch (error) {
      if (toAppError(error).code === "repo.not_found") await openFolder(path);
      else report(error);
      return;
    }
    replace(answer.project);
    await open(answer.project.id, answer.repository);
  }

  /**
   * Shows the repository at `path` wherever it is (the palette, the switcher): in the open
   * project when it holds it, else in the project opened last among those that do, else in
   * the project `openPath` finds or makes for it.
   */
  async function openRepository(path: string): Promise<void> {
    if (active.value?.members.some((member) => sameFolder(member.path, path))) {
      await show(path);
      return;
    }
    const holder = openedLast(holding(path));
    if (holder) await open(holder.id, path);
    else await openPath(path);
  }

  /** Shows the member after (1) or before (-1) the shown one in the open project. */
  async function openNeighbour(step: 1 | -1): Promise<boolean> {
    const next = neighbourOf(activeMembers.value, shownPath.value, step);
    if (!next) return false;
    await show(next.path);
    return true;
  }

  /** Leaves the open project for Home ("Go to projects"). */
  async function close(): Promise<void> {
    waitingFirst = null;
    if (settings.values.activeProject !== null) void settings.update("activeProject", null);
    if (shell.layoutMode !== "graph" && shell.layoutMode !== "settings") {
      void shell.setLayoutMode("graph");
    }
    await repo.close();
  }

  /**
   * A repository the scan of `folder` found: the folder's project holds it now, as the backend
   * made it; a folder project opened before its first one shows it at once.
   */
  function noteFound(entry: IndexEntry, folder: string): void {
    const project = folderProjectOf(folder);
    if (!project) return;
    const at = project.members.findIndex((member) => sameFolder(member.path, entry.path));
    const own = project.members.filter(
      (member) => member.origin === "folder" && !sameFolder(member.path, entry.path),
    );
    const hand = project.members.filter(
      (member) => member.origin === "hand" && !sameFolder(member.path, entry.path),
    );
    if (at < 0 || project.members[at]?.origin === "hand") {
      const found = [...own, { path: entry.path, origin: "folder" as const }].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
      replace({ ...project, members: [...found, ...hand] });
    }
    if (waitingFirst === project.id && active.value?.id === project.id) {
      if (repo.state.kind === "empty") void show(entry.path);
      waitingFirst = null;
    }
  }

  /**
   * Reopens the open project at launch, showing the repository it showed last (its first when
   * that one left it); a project that is gone leaves Home. A repository that cannot be opened
   * leaves the shell in its error state inside the project.
   */
  async function restore(): Promise<void> {
    const project = active.value;
    if (!project) {
      if (settings.values.activeProject !== null) void settings.update("activeProject", null);
      if (shell.layoutMode === "overview" || shell.layoutMode === "changes") {
        void shell.setLayoutMode("graph");
      }
      return;
    }
    const target = firstShown(project);
    if (target === null) return;
    remember(project.id, target);
    await repo.open(target);
    await index.afterOpen(target);
  }

  // --- Writes ---------------------------------------------------------------------------------

  /**
   * Makes a list project of `paths` in their order; the ones the index does not list yet (added
   * with "Add repository…") are stored now that a project names them. Null when refused.
   */
  async function create(name: string, paths: string[]): Promise<Project | null> {
    let project: Project;
    try {
      project = await ipc.createProject(name, paths);
    } catch (error) {
      report(error);
      return null;
    }
    replace(project);
    const unknown = paths.filter((path) => !index.lookup(path));
    await Promise.all(unknown.map((path) => index.refresh(path, false)));
    return project;
  }

  /** Makes (or finds) the folder project of `folder` and scans it ("Add folder"). */
  async function createFolder(folder: string): Promise<Project | null> {
    let project: Project;
    try {
      project = await lookingUp(folder, () => ipc.createFolderProject(folder));
    } catch (error) {
      report(error);
      return null;
    }
    replace(project);
    index.startScan([project.folder ?? folder]);
    return project;
  }

  async function rename(id: number, name: string): Promise<Project | null> {
    try {
      const answer = await ipc.renameProject(id, name);
      if (answer) replace(answer);
      else await forgetProject(id);
      return answer;
    } catch (error) {
      report(error);
      return null;
    }
  }

  /** A project that is gone (another window, a stale id): it leaves the list and the screen. */
  async function forgetProject(id: number): Promise<void> {
    projects.value = projects.value.filter((known) => known.id !== id);
    if (settings.values.activeProject === id) await close();
  }

  /** When the open project no longer holds the repository it shows, it shows another. */
  async function settleShown(): Promise<void> {
    const project = active.value;
    const shown = shownPath.value;
    if (!project || shown === null) return;
    if (project.members.some((member) => sameFolder(member.path, shown))) return;
    const next = firstShown(project);
    if (next !== null) await show(next);
    else await repo.close();
  }

  /**
   * Replaces the members project `id` holds by hand, in their order (a folder project keeps
   * its folder's own); the ones that left the index go from the listing. Null when refused or
   * when the project is gone.
   */
  async function setMembers(id: number, paths: string[]): Promise<ProjectEdit | null> {
    let edit: ProjectEdit | null;
    try {
      edit = await ipc.setProjectMembers(id, paths);
    } catch (error) {
      report(error);
      return null;
    }
    if (!edit) {
      await forgetProject(id);
      return null;
    }
    replace(edit.project);
    index.drop(edit.removed);
    const unknown = paths.filter((path) => !index.lookup(path));
    await Promise.all(unknown.map((path) => index.refresh(path, false)));
    await settleShown();
    return edit;
  }

  /** The paths project `id` holds by hand, in its order. */
  function handPaths(project: Project): string[] {
    return project.members.filter((member) => member.origin === "hand").map((m) => m.path);
  }

  /**
   * Takes `path` out of the open project ("Remove from project"): a member added by hand
   * leaves at once; one of its folder's own leaves when a scan of the folder no longer finds
   * it, so the folder is scanned again.
   */
  async function removeMember(path: string): Promise<void> {
    const project = active.value;
    const member = project?.members.find((known) => sameFolder(known.path, path));
    if (!project || !member) return;
    if (member.origin === "folder" && project.folder !== null) {
      index.startScan([project.folder]);
      return;
    }
    await setMembers(
      project.id,
      handPaths(project).filter((known) => !sameFolder(known, path)),
    );
  }

  /**
   * "Remove from project": a member that belongs to no other project leaves Begitra with it,
   * so its removal asks first (`RemoveMemberDialog`); the others go at once.
   */
  function askRemoveMember(path: string): void {
    const project = active.value;
    const member = project?.members.find((known) => sameFolder(known.path, path));
    if (!project || !member) return;
    if (member.origin === "hand" && leaving(project, [path]).length > 0) {
      useProjectDialogsStore().askRemove(path);
    } else {
      void removeMember(path);
    }
  }

  /**
   * Adds `path` (a worktree just made) to the open project: by hand, and one of its folder's
   * own once a scan of the folder finds it when it lies under it.
   */
  async function join(path: string): Promise<void> {
    const project = active.value;
    if (!project || project.members.some((member) => sameFolder(member.path, path))) return;
    const edit = await setMembers(project.id, [...handPaths(project), path]);
    if (edit && project.folder !== null && isUnder(project.folder, path)) {
      index.startScan([project.folder]);
    }
  }

  /** Pins or unpins a project at once; a refusal reverts it and shows a toast. */
  async function setPinned(id: number, pinnedNow: boolean): Promise<void> {
    const before = find(id);
    if (!before) return;
    patchProject(id, { pinned: pinnedNow });
    try {
      if (!(await ipc.setProjectPinned(id, pinnedNow))) await forgetProject(id);
    } catch (error) {
      patchProject(id, { pinned: before.pinned });
      report(error);
    }
  }

  /**
   * Deletes a project, never a repository's folder; its repositories that belong to no other
   * project leave the listing, and the open project gives way to Home. Resolves with those
   * paths, or null when the deletion was refused.
   */
  async function remove(id: number): Promise<string[] | null> {
    const project = find(id);
    let removed: string[] | null;
    try {
      removed = await ipc.deleteProject(id);
    } catch (error) {
      report(error);
      return null;
    }
    projects.value = projects.value.filter((known) => known.id !== id);
    index.drop(removed ?? []);
    if (project?.folder) index.forgetFolder(project.folder);
    if (settings.values.activeProject === id) await close();
    return removed ?? [];
  }

  // --- The settings of a version before projects ----------------------------------------------

  /** The project the app was left on by a version before projects. */
  async function legacyActive(legacy: LegacySettings): Promise<number | null> {
    if (legacy.layoutMode === "project")
      return find(settings.values.activeProject ?? -1)?.id ?? null;
    if (legacy.layoutMode === "folder" && legacy.folderView !== null) {
      const known = folderProjectOf(legacy.folderView);
      if (known) return known.id;
      try {
        const made = await ipc.createFolderProject(legacy.folderView);
        replace(made);
        return made.id;
      } catch {
        return null;
      }
    }
    const last = legacy.lastRepository;
    if (last === null) return null;
    const current = find(settings.values.activeProject ?? -1);
    if (current?.members.some((member) => sameFolder(member.path, last))) {
      remember(current.id, last);
      return current.id;
    }
    try {
      const answer = await ipc.projectForPath(last);
      replace(answer.project);
      remember(answer.project.id, answer.repository);
      return answer.project.id;
    } catch {
      // The repository is gone: the app starts on Home.
      return null;
    }
  }

  /**
   * The one-time step for a settings file of a version before projects, after the first
   * listing: a folder project for each scan folder the index has none for (never scanned, or
   * empty), the open project from where the app was left (the project view's project, the
   * folder view's folder, or the project holding the last repository, the open one first),
   * then the old keys go.
   */
  async function migrateSettings(): Promise<void> {
    const legacy = settings.legacy;
    if (!legacy) return;
    for (const root of legacy.scanRoots) {
      if (folderProjectOf(root)) continue;
      try {
        replace(await ipc.createFolderProject(root));
      } catch {
        // A scan folder that is gone has no project to become.
      }
    }
    const opened = await legacyActive(legacy);
    if (opened !== settings.values.activeProject) void settings.update("activeProject", opened);
    await settings.dropLegacy();
  }

  return {
    projects,
    loaded,
    loadError,
    active,
    activeMembers,
    multi,
    view,
    shownPath,
    sorted,
    pinned,
    recent,
    folders,
    find,
    members,
    isShown,
    folderProjectOf,
    holding,
    leaving,
    folderCounts,
    load,
    show,
    open,
    openFolder,
    openPath,
    openRepository,
    openNeighbour,
    close,
    noteFound,
    restore,
    create,
    createFolder,
    rename,
    setMembers,
    removeMember,
    askRemoveMember,
    join,
    setPinned,
    remove,
    migrateSettings,
  };
});
