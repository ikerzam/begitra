// The ignore rules an untracked file offers and the line each one writes, as the engine writes
// it (`git2_engine/ignore.rs`), for the dialog to show before anything is written: the path
// anchored at the root, `*.` and its extension, or its folder anchored; each name's `\`, `*`,
// `?`, `[` and trailing spaces escaped, so the line matches that name alone. A folder git lists
// whole (a nested repository, `nested/`) keeps its slash and has no extension.

import type { IgnoreRule } from "@/ipc/schemas";

/** A name as a pattern that matches it alone. */
function escape(name: string): string {
  const kept = name.replace(/ +$/, "");
  const escaped = kept.replace(/[\\*?[]/g, (c) => `\\${c}`);
  return escaped + "\\ ".repeat(name.length - kept.length);
}

/** The extension of a file name: after its last dot, past its first character, not empty. */
function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : null;
}

/** Whether git lists `path` as a folder: with a trailing slash. */
export function isFolderEntry(path: string): boolean {
  return path.endsWith("/");
}

/** The names of `path`, its trailing slash aside. */
function namesOf(path: string): string[] {
  return (isFolderEntry(path) ? path.slice(0, -1) : path).split("/");
}

/** The extension of an entry: none for a folder. */
function entryExtension(path: string): string | null {
  return isFolderEntry(path) ? null : extensionOf(namesOf(path).at(-1) ?? "");
}

/** The rules `path` (repository-relative, `/` between names) has something for. */
export function ignoreRules(path: string): IgnoreRule[] {
  const rules: IgnoreRule[] = ["file"];
  if (entryExtension(path) !== null) rules.push("extension");
  if (namesOf(path).length > 1) rules.push("folder");
  return rules;
}

/** The line `rule` writes for `path`; null when the path has nothing for the rule. */
export function ignoreLine(path: string, rule: IgnoreRule): string | null {
  const names = namesOf(path);
  const anchored = (parts: string[]) => `/${parts.map(escape).join("/")}`;
  if (rule === "file") return isFolderEntry(path) ? `${anchored(names)}/` : anchored(names);
  if (rule === "extension") {
    const extension = entryExtension(path);
    return extension === null ? null : `*.${escape(extension)}`;
  }
  return names.length > 1 ? `${anchored(names.slice(0, -1))}/` : null;
}
