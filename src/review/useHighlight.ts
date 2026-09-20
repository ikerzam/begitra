// Lazy highlighting of the open file: once the rows are on screen, the token classes of both
// sides are asked for (cached per blob on the backend) for the lines the hunks show, and
// applied to the rendered segments; a file change cancels what is in flight (the backend
// operation included), and a failure leaves the rows plain.

import { computed, ref, watch, type Ref } from "vue";

import * as ipc from "@/ipc/commands";
import { newOpId } from "@/ipc/invoke";
import type { BlobAt, DiffLine, FileChange, Highlight, LineRange, Token } from "@/ipc/schemas";
import type { ReviewTarget } from "@/stores/review";

import { fileSides } from "./sides";

/** The line runs of a file's hunks on one side, so the backend ships only their tokens. */
export function hunkRanges(file: FileChange, side: "old" | "new"): LineRange[] {
  return file.hunks.map((hunk) =>
    side === "old"
      ? { start: hunk.oldStart, end: hunk.oldStart + Math.max(hunk.oldLines, 1) - 1 }
      : { start: hunk.newStart, end: hunk.newStart + Math.max(hunk.newLines, 1) - 1 },
  );
}

export interface LineTokens {
  /** Tokens of a line by its number on the old side. */
  old: (line: DiffLine) => Token[];
  /** Tokens of a line by its number on the new side. */
  new: (line: DiffLine) => Token[];
}

const NONE: Token[] = [];

export function useHighlight(
  root: Ref<string | null>,
  target: Ref<ReviewTarget | null>,
  file: Ref<FileChange | null>,
  enabled: Ref<boolean>,
) {
  const oldSide = ref<Highlight | null>(null);
  const newSide = ref<Highlight | null>(null);
  let serial = 0;
  let inFlight: string[] = [];

  function cancelInFlight(): void {
    for (const opId of inFlight) void ipc.cancelOperation(opId).catch(() => undefined);
    inFlight = [];
  }

  async function load(): Promise<void> {
    serial += 1;
    const mine = serial;
    cancelInFlight();
    oldSide.value = null;
    newSide.value = null;
    const repoRoot = root.value;
    const current = target.value;
    const open = file.value;
    if (!enabled.value || !repoRoot || !current || !open || open.isBinary) return;
    const sides = fileSides(current, open);
    const ask = async (side: { at: BlobAt; path: string } | null, which: "old" | "new") => {
      if (!side) return null;
      const opId = newOpId("hl");
      inFlight.push(opId);
      try {
        return await ipc.highlightFile(repoRoot, side.at, side.path, hunkRanges(open, which), opId);
      } catch {
        return null;
      } finally {
        inFlight = inFlight.filter((id) => id !== opId);
      }
    };
    const [older, newer] = await Promise.all([ask(sides.old, "old"), ask(sides.new, "new")]);
    if (mine !== serial) return;
    oldSide.value = older;
    newSide.value = newer;
  }

  // The file object changes whenever the change set reloads, so an edit that keeps the
  // path asks again.
  watch([root, () => target.value, file, enabled], () => void load(), { immediate: true });

  const tokens = computed<LineTokens>(() => {
    const older = oldSide.value;
    const newer = newSide.value;
    return {
      old: (line) => (line.oldNumber !== null ? (older?.lines[line.oldNumber - 1] ?? NONE) : NONE),
      new: (line) => (line.newNumber !== null ? (newer?.lines[line.newNumber - 1] ?? NONE) : NONE),
    };
  });

  /** The tokens of a line from the side it belongs to. */
  function tokensOf(line: DiffLine): Token[] {
    return line.kind === "removed" ? tokens.value.old(line) : tokens.value.new(line);
  }

  return { tokens, tokensOf, reload: load };
}
