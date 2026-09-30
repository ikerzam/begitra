// Index entries and projects for tests: a clean summary on `main` and an entry at a path, each
// overridable field by field.

import type { IndexEntry, Project, RepoSummary } from "@/ipc/schemas";

export function summaryOf(over: Partial<RepoSummary> = {}): RepoSummary {
  return {
    currentBranch: "main",
    detached: false,
    upstream: { name: "origin/main", remote: "origin", branch: "main", pushRemote: "origin" },
    ahead: 0,
    behind: 0,
    operation: "none",
    fetchedAt: 1_704_000_000,
    lastCommitAt: 1_704_000_000,
    lastCommitSubject: "feat: a commit",
    dirty: false,
    ...over,
  };
}

/** The entry of the repository at `path`, named after its folder, found under its parent. */
export function entryOf(path: string, over: Partial<IndexEntry> = {}): IndexEntry {
  const at = path.lastIndexOf("/");
  return {
    path,
    name: path.slice(at + 1),
    kind: "main",
    parentPath: null,
    scanRoot: path.slice(0, at),
    summary: summaryOf(),
    pinned: false,
    lastOpenedAt: null,
    refreshedAt: 1_704_000_100,
    missing: false,
    ...over,
  };
}

/** A linked worktree of `parent` at `path`. */
export function worktreeOf(path: string, parent: string, over: Partial<IndexEntry> = {}) {
  return entryOf(path, { kind: "worktree", parentPath: parent, ...over });
}

/** A list project holding `members` by hand, in their order. */
export function projectOf(
  id: number,
  name: string,
  members: string[],
  over: Partial<Project> = {},
): Project {
  return {
    id,
    name,
    kind: "list",
    folder: null,
    members: members.map((path) => ({ path, origin: "hand" as const })),
    pinned: false,
    openedAt: null,
    lastRepository: null,
    createdAt: 1_704_000_000,
    updatedAt: 1_704_000_000,
    ...over,
  };
}

/** The folder project of `folder`: `found` as its folder's own members, then `hand` ones. */
export function folderProjectOf(
  id: number,
  folder: string,
  found: string[],
  hand: string[] = [],
  over: Partial<Project> = {},
): Project {
  return {
    ...projectOf(id, folder.slice(folder.lastIndexOf("/") + 1), [], over),
    kind: "folder",
    folder,
    members: [
      ...found.map((path) => ({ path, origin: "folder" as const })),
      ...hand.map((path) => ({ path, origin: "hand" as const })),
    ],
    ...over,
  };
}

/** The members' paths of `project`, in its order. */
export function pathsOf(project: Pick<Project, "members">): string[] {
  return project.members.map((member) => member.path);
}
