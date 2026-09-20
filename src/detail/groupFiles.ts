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

/** The type categories of the review rail; each is an i18n key under `review.types`. */
export const fileTypes = [
  "typescript",
  "tsx",
  "javascript",
  "vue",
  "rust",
  "python",
  "go",
  "json",
  "yaml",
  "toml",
  "markdown",
  "css",
  "html",
  "images",
  "lockfile",
  "other",
] as const;

export type FileType = (typeof fileTypes)[number];

const typeByExtension: Record<string, FileType> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  vue: "vue",
  rs: "rust",
  py: "python",
  go: "go",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "css",
  html: "html",
  png: "images",
  jpg: "images",
  jpeg: "images",
  gif: "images",
  svg: "images",
  webp: "images",
  ico: "images",
};

/** The type category of a path: lockfiles first, then by extension, else "other". */
export function typeOf(path: string): FileType {
  if (isLockfile(path)) return "lockfile";
  const name = splitPath(path).name;
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return typeByExtension[extension] ?? "other";
}

/** Files by type category, most frequent first, then by key. */
export function byType(files: FileChange[]): { type: FileType; count: number }[] {
  const counts = new Map<FileType, number>();
  for (const file of files) {
    const type = typeOf(file.path);
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

/**
 * A path matcher from the files panel's filter: a glob when it holds `*`, `?` or `[`
 * (`*` stops at `/`, `**` crosses it, a pattern without `/` matches the file name), a
 * case-insensitive substring of the path otherwise. An empty filter matches everything.
 */
export function pathMatcher(filter: string): (path: string) => boolean {
  const text = filter.trim();
  if (text === "") return () => true;
  if (!/[*?[]/.test(text)) {
    const needle = text.toLowerCase();
    return (path) => path.toLowerCase().includes(needle);
  }
  let source = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === "*") {
      if (text[i + 1] === "*") {
        source += ".*";
        i += 1;
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else if (char === "[") {
      const close = text.indexOf("]", i);
      if (close > i) {
        source += text.slice(i, close + 1);
        i = close;
      } else source += "\\[";
    } else source += char.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  const anchored = text.includes("/") ? `^${source}$` : `(^|/)${source}$`;
  try {
    const regex = new RegExp(anchored, "i");
    return (path) => regex.test(path);
  } catch {
    const needle = text.toLowerCase();
    return (path) => path.toLowerCase().includes(needle);
  }
}

/** Files by the size of their change (additions plus deletions), largest first. */
export function sortBySize(files: FileChange[]): FileChange[] {
  return [...files].sort(
    (a, b) =>
      b.additions + b.deletions - (a.additions + a.deletions) || a.path.localeCompare(b.path),
  );
}

/** The top-level folders with the most files changed. */
export function byDirectory(files: FileChange[], limit = 5): { folder: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const { folder } = splitPath(file.path);
    const top = folder === "/" ? "/" : (folder.split("/")[0] ?? folder);
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([folder, count]) => ({ folder, count }))
    .sort((a, b) => b.count - a.count || a.folder.localeCompare(b.folder))
    .slice(0, limit);
}
