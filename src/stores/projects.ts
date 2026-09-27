// Projects: named, ordered groups of repositories and worktrees kept in the index by
// path. The store keeps the list, the active project (the last one whose view was shown), each
// project's members resolved against the index (a path the index no longer lists, or whose
// folder is gone, is a missing member; none is while the index is not read), what needs
// attention on Home, and the next or previous member for Alt ↓ and Alt ↑. Making, editing or
// deleting a project writes to no repository.

import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";

import { i18n } from "@/i18n";
import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import type { IndexEntry, OperationState, Project } from "@/ipc/schemas";
import { errorText } from "@/shell/errorMessage";
import { baseName, sameFolder } from "@/shell/format";

import { useIndexStore } from "./index";
import { useRepoStore } from "./repo";
import { useSettingsStore, type ProjectTab } from "./settings";
import { useShellStore } from "./shell";
import { useToastsStore } from "./toasts";

/** A project's member as the Overview and the dialogs show it. */
export interface ProjectMember {
  path: string;
  /** Its index entry; null when the index does not list the path. */
  entry: IndexEntry | null;
  /** No index entry, or a folder the index found gone; never while the index is not read. */
  missing: boolean;
  /** The entry's name (the folder's name without one), with its parent folder when another
   * member shares it. */
  name: string;
}

/** What Home's line of a project counts. */
export interface ProjectAttention {
  changes: number;
  behind: number;
  /** Members in the middle of each kind of operation. */
  operations: Partial<Record<Exclude<OperationState, "none">, number>>;
  missing: number;
}

function byName(a: Project, b: Project): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id - b.id;
}

/** The folder `path` lies in, by name. */
function parentName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return at > 0 ? baseName(trimmed.slice(0, at)) : "";
}

/**
 * The members of `project` in its order against the index `entries`: each path with its entry
 * (spelled as the index spells it), missing when there is none or its folder is gone. Until the
 * index is `read`, no member is missing: its entry is only not known yet.
 */
export function resolveMembers(
  project: Project,
  entries: readonly IndexEntry[],
  read = true,
): ProjectMember[] {
  const members = project.members.map((path) => {
    const entry = entries.find((candidate) => sameFolder(candidate.path, path)) ?? null;
    return {
      path: entry?.path ?? path,
      entry,
      missing: read && (entry === null || entry.missing),
      name: entry?.name ?? baseName(path),
    };
  });
  const counts = new Map<string, number>();
  for (const member of members) {
    const key = member.name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return members.map((member) =>
    (counts.get(member.name.toLowerCase()) ?? 0) > 1
      ? { ...member, name: `${parentName(member.path)}/${member.name}` }
      : member,
  );
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

export const useProjectsStore = defineStore("projects", () => {
  const settings = useSettingsStore();
  const index = useIndexStore();
  const shell = useShellStore();
  const toasts = useToastsStore();

  // Replaced as a whole on every change: a handful of projects, each a list of paths.
  const projects = shallowRef<Project[]>([]);
  const loaded = ref(false);
  const loadError = ref<AppError | null>(null);

  const active = computed(
    () => projects.value.find((project) => project.id === settings.values.activeProject) ?? null,
  );

  function find(id: number): Project | undefined {
    return projects.value.find((project) => project.id === id);
  }

  function members(project: Project): ProjectMember[] {
    return resolveMembers(project, index.entries, index.read);
  }

  /** The active project's members; empty without one. */
  const activeMembers = computed(() => (active.value ? members(active.value) : []));

  /** Whether the open repository belongs to the active project. */
  const openIsMember = computed(() => {
    const root = useRepoStore().repo?.root;
    if (root === undefined) return false;
    return activeMembers.value.some((member) => sameFolder(member.path, root));
  });

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
    projects.value = [...projects.value.filter((known) => known.id !== project.id), project].sort(
      byName,
    );
  }

  /** Lists the projects; a failure is kept in `loadError` and the list stays as it was. */
  async function load(): Promise<void> {
    try {
      projects.value = (await ipc.listProjects()).sort(byName);
      loadError.value = null;
    } catch (error) {
      loadError.value = toAppError(error);
    } finally {
      loaded.value = true;
    }
  }

  /** Makes a project of `paths` in their order; null when the index refused it. */
  async function create(name: string, paths: string[]): Promise<Project | null> {
    try {
      const project = await ipc.createProject(name, paths);
      replace(project);
      return project;
    } catch (error) {
      report(error);
      return null;
    }
  }

  /** Stores what a rename or a new member list answered; a project gone meanwhile goes. */
  function settle(id: number, answer: Project | null): Project | null {
    if (answer) replace(answer);
    else projects.value = projects.value.filter((known) => known.id !== id);
    return answer;
  }

  async function rename(id: number, name: string): Promise<Project | null> {
    try {
      return settle(id, await ipc.renameProject(id, name));
    } catch (error) {
      report(error);
      return null;
    }
  }

  async function setMembers(id: number, paths: string[]): Promise<Project | null> {
    try {
      return settle(id, await ipc.setProjectMembers(id, paths));
    } catch (error) {
      report(error);
      return null;
    }
  }

  /** Deletes a project, never a repository; its view gives way to Home or the graph. */
  async function remove(id: number): Promise<boolean> {
    try {
      await ipc.deleteProject(id);
    } catch (error) {
      report(error);
      return false;
    }
    projects.value = projects.value.filter((known) => known.id !== id);
    if (settings.values.activeProject === id) {
      await settings.update("activeProject", null);
      if (shell.layoutMode === "project") await shell.setLayoutMode("graph");
    }
    return true;
  }

  /**
   * Shows the view of project `id` on `tab` (the tab it was on when none is given). The
   * settings change at once and reach the disk together, so the view shows without waiting.
   */
  async function open(id: number, tab?: ProjectTab): Promise<void> {
    const writes: Promise<void>[] = [];
    if (settings.values.activeProject !== id) writes.push(settings.update("activeProject", id));
    if (tab !== undefined && settings.values.projectTab !== tab) {
      writes.push(settings.update("projectTab", tab));
    }
    writes.push(shell.setLayoutMode("project"));
    await Promise.all(writes);
  }

  /**
   * Makes a project of the scan folder `folder`'s repositories and worktrees in path order,
   * named after the folder, and shows it on `tab` ("Save as project").
   */
  async function saveFolder(folder: string, tab?: ProjectTab): Promise<Project | null> {
    const paths = index.entries
      .filter(
        (entry) => entry.scanRoot !== null && sameFolder(entry.scanRoot, folder) && !entry.missing,
      )
      .map((entry) => entry.path)
      .sort((a, b) => a.localeCompare(b));
    const project = await create(baseName(folder), paths);
    if (project) await open(project.id, tab);
    return project;
  }

  /** Opens the member after (1) or before (-1) the open repository in the active project. */
  async function openNeighbour(step: 1 | -1): Promise<boolean> {
    const current = useRepoStore().repo?.root ?? null;
    const next = neighbourOf(activeMembers.value, current, step);
    if (!next) return false;
    await index.open(next.path);
    if (shell.layoutMode === "project") await shell.setLayoutMode("graph");
    return true;
  }

  return {
    projects,
    loaded,
    loadError,
    active,
    activeMembers,
    openIsMember,
    find,
    members,
    load,
    create,
    rename,
    setMembers,
    remove,
    open,
    saveFolder,
    openNeighbour,
  };
});
