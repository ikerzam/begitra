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

export function projectOf(id: number, name: string, members: string[]): Project {
  return { id, name, members, createdAt: 1_704_000_000, updatedAt: 1_704_000_000 };
}
