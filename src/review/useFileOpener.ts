// Where a file of the diff opens in the editor: the working tree's file at its first change,
// or, for a conflicted (unmerged) file, at its first conflict marker, which its diff does not
// hold (libgit2 gives an unmerged file no hunks) and a read of the file finds.

import type { Ref } from "vue";

import { readBlob } from "@/ipc/commands";
import type { FileChange } from "@/ipc/schemas";
import { useExternal } from "@/shell/useExternal";
import { useShortcut } from "@/shortcuts/useShortcut";

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

/** Whether `file` is a conflict whose diff is empty: its line is its first marker, read later. */
function markersOnly(file: FileChange): boolean {
  return file.status === "unmerged" && file.hunks.length === 0;
}

/** The line the header opens `file` at when its diff tells: the new side's first change. */
export function headerLine(file: FileChange): number | null {
  return markersOnly(file) ? null : firstChangedLine(file.hunks);
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
    const line = markersOnly(file) ? await conflictLine(at, file.path) : headerLine(file);
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

/**
 * A viewer's ⇧⌘E ("Open file in editor"): the shown file at `lineAtTop` (the line at the
 * cursor or at the top of its rows), or, where no rows show it (a card, an image), where its
 * header's button opens it. Bound only while the file can be opened, so a deleted file leaves
 * the key and the palette row inactive.
 */
export function useOpenFileShortcut(
  root: Ref<string | null>,
  file: Ref<FileChange | null>,
  lineAtTop: () => number | null | undefined,
): void {
  const opener = useFileOpener(root);
  const external = useExternal();
  useShortcut(
    "open-file-editor",
    () => {
      const open = file.value;
      const at = root.value;
      if (!open || at === null) return;
      const line = lineAtTop();
      if (line === undefined) void opener.openFile(open);
      else void external.openFile(at, open.path, line);
    },
    () => file.value !== null && opener.canOpen(file.value),
  );
}
