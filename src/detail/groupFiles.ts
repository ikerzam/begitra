// Groups a change set by folder for the file list of the detail panel and the files panel of
// review focus. Pure, so it is unit-tested on data.

import type { FileStatus } from "@/components/types";
import type { ChangeKind, FileChange } from "@/ipc/schemas";

export interface FileEntry {
  file: FileChange;
  name: string;
  status: FileStatus;
}

export interface FolderGroup {
  /** Folder path, or "/" for the repository root. */
  folder: string;
  files: FileEntry[];
}

export interface ChangeTotals {
  files: number;
  additions: number;
  deletions: number;
  added: number;
  modified: number;
  deleted: number;
  generated: number;
  tests: number;
  binary: number;
}

/** The single status letter shown for a change kind. */
export function statusOf(kind: ChangeKind): FileStatus {
  switch (kind) {
    case "added":
    case "copied":
      return "added";
    case "deleted":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}

export function splitPath(path: string): { folder: string; name: string } {
  const at = path.lastIndexOf("/");
  if (at < 0) return { folder: "/", name: path };
  return { folder: path.slice(0, at), name: path.slice(at + 1) };
}

/** Groups by folder in the order folders first appear; files keep the change set order. */
export function groupFiles(files: FileChange[]): FolderGroup[] {
  const groups = new Map<string, FolderGroup>();
  for (const file of files) {
    const { folder, name } = splitPath(file.path);
    let group = groups.get(folder);
    if (!group) {
      group = { folder, files: [] };
      groups.set(folder, group);
    }
    group.files.push({ file, name, status: statusOf(file.status) });
  }
  const result = [...groups.values()];
  // The root group goes last.
  return [...result.filter((g) => g.folder !== "/"), ...result.filter((g) => g.folder === "/")];
}

export function totals(files: FileChange[]): ChangeTotals {
  const result: ChangeTotals = {
    files: files.length,
    additions: 0,
    deletions: 0,
    added: 0,
    modified: 0,
    deleted: 0,
    generated: 0,
    tests: 0,
    binary: 0,
  };
  for (const file of files) {
    result.additions += file.additions;
    result.deletions += file.deletions;
    const status = statusOf(file.status);
    if (status === "added") result.added += 1;
    else if (status === "deleted") result.deleted += 1;
    else result.modified += 1;
    if (file.isGenerated) result.generated += 1;
    if (file.isTest) result.tests += 1;
    if (file.isBinary) result.binary += 1;
  }
  return result;
}

/** Files by extension (or "other"), most frequent first. */
export function byType(files: FileChange[]): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const name = splitPath(file.path).name;
    const dot = name.lastIndexOf(".");
    const type = dot > 0 ? name.slice(dot + 1).toLowerCase() : "other";
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

/** The files with the most changed lines, largest first. */
export function largest(files: FileChange[], limit = 3): FileChange[] {
  return [...files]
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
    .slice(0, limit);
}

export interface FileFilters {
  hideGenerated: boolean;
  hideLockfiles: boolean;
  hideTests: boolean;
}

const lockfiles = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "bun.lock",
  "bun.lockb",
]);

export function isLockfile(path: string): boolean {
  return lockfiles.has(splitPath(path).name);
}

export function applyFilters(files: FileChange[], filters: FileFilters): FileChange[] {
  return files.filter((file) => {
    if (filters.hideLockfiles && isLockfile(file.path)) return false;
    if (filters.hideGenerated && file.isGenerated && !isLockfile(file.path)) return false;
    if (filters.hideTests && file.isTest) return false;
    return true;
  });
}
