// Where a file of the diff opens in the editor: the working tree's file at its first change,
// or, for a conflicted (unmerged) file, at its first conflict marker, which its diff does not
// hold (libgit2 gives an unmerged file no hunks) and a read of the file finds.

import type { Ref } from "vue";

import { readBlob } from "@/ipc/commands";
import type { FileChange } from "@/ipc/schemas";
import { useExternal } from "@/shell/useExternal";

import { firstChangedLine } from "./diffRows";

/** The first line of `text` that starts a conflict (`<<<<<<<`), 1-based; null without one. */
export function firstConflictMarker(text: string): number | null {
  const index = text.split("\n").findIndex((line) => line.startsWith("<<<<<<<"));
  return index < 0 ? null : index + 1;
}

/** The line a conflicted file opens at: its first marker, or its top when it has none. */
async function conflictLine(root: string, path: string): Promise<number | null> {
  try {
    const blob = await readBlob(root, { kind: "working-tree" }, path);
    return blob.text === undefined ? null : firstConflictMarker(blob.text);
  } catch {
    // The file cannot be read: open it at its top; the open names a file not on disk.
    return null;
  }
}

/** Opens files of the working tree at `root` in the editor. */
export function useFileOpener(root: Ref<string | null>) {
  const external = useExternal();

  /** Whether `file` has a working-tree file to open: a deletion has none. */
  function canOpen(file: FileChange): boolean {
    return root.value !== null && file.status !== "deleted";
  }

  /** Opens `file` at its first change, or a conflicted file at its first conflict marker. */
  async function openFile(file: FileChange): Promise<boolean> {
    const at = root.value;
    if (at === null || !canOpen(file)) return false;
    const line =
      file.status === "unmerged" && file.hunks.length === 0
        ? await conflictLine(at, file.path)
        : firstChangedLine(file.hunks);
    return external.openFile(at, file.path, line);
  }

  /** Opens the file at `path` at its first conflict marker (a conflict row has no diff). */
  async function openConflict(path: string): Promise<boolean> {
    const at = root.value;
    if (at === null) return false;
    return external.openFile(at, path, await conflictLine(at, path));
  }

  return { canOpen, openFile, openConflict };
}
