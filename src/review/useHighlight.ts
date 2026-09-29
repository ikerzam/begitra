// Lazy highlighting of the open file: once the rows are on screen, the token classes of both
// sides are asked for (cached per blob on the backend) for the lines the shown hunks cover,
// and on the new side the unchanged lines shown around them, and applied to the rendered
// segments. A load is keyed by what it depends on (the sides, their contents' ids and the
// lines asked for): a reload with the same key keeps the colours shown, so a change set listed
// again without a change draws no frame without them; when only the lines asked for changed
// (lines revealed), the colours shown stay until the answer arrives and the old side, whose
// lines did not change, is not asked again; another key cancels what is in flight (the
// backend operation included). A failure leaves the rows plain.

import { computed, ref, watch, type Ref } from "vue";

import * as ipc from "@/ipc/commands";
import { newOpId } from "@/ipc/invoke";
import type {
  BlobAt,
  DiffLine,
  FileChange,
  Highlight,
  Hunk,
  LineRange,
  Token,
} from "@/ipc/schemas";
import type { ReviewTarget } from "@/stores/review";

import { fileSides } from "./sides";
import { mergeRanges } from "./unchanged";

/** The line runs of `hunks` on one side, so the backend ships only their tokens. */
export function hunkRanges(hunks: readonly Hunk[], side: "old" | "new"): LineRange[] {
  return hunks.map((hunk) =>
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

type Side = { at: BlobAt; path: string } | null;

/** What a load of `file` depends on; equal keys ask for the same tokens of the same contents. */
export function highlightKey(
  repoRoot: string,
  sides: { old: Side; new: Side },
  file: FileChange,
  ranges: { old: LineRange[]; new: LineRange[] },
): string {
  return JSON.stringify([repoRoot, sides, file.oldId, file.newId, ranges]);
}

const NONE: Token[] = [];

export function useHighlight(
  root: Ref<string | null>,
  target: Ref<ReviewTarget | null>,
  file: Ref<FileChange | null>,
  /** The hunks on screen: the file's, or the one "Show new file" lists. */
  hunks: Ref<readonly Hunk[]>,
  enabled: Ref<boolean>,
  /** The new side's unchanged lines shown around the hunks. */
  unchanged: Ref<readonly LineRange[]> = ref([]),
) {
  const oldSide = ref<Highlight | null>(null);
  const newSide = ref<Highlight | null>(null);
  let serial = 0;
  let inFlight: string[] = [];
  /** The key of the tokens shown or being loaded; null when nothing is. */
  let loaded: string | null = null;
  /** The same without the lines asked for: the sides and their contents. */
  let loadedContents: string | null = null;
  /** The old side's lines asked for with it. */
  let loadedOld: string | null = null;

  function cancelInFlight(): void {
    for (const opId of inFlight) void ipc.cancelOperation(opId).catch(() => undefined);
    inFlight = [];
  }

  async function load(): Promise<void> {
    const repoRoot = root.value;
    const current = target.value;
    const open = file.value;
    const ready = enabled.value && repoRoot && current && open && !open.isBinary;
    const sides = ready ? fileSides(current, open) : null;
    const ranges = {
      old: hunkRanges(hunks.value, "old"),
      new: mergeRanges([...hunkRanges(hunks.value, "new"), ...unchanged.value]),
    };
    const key = ready && sides ? highlightKey(repoRoot, sides, open, ranges) : null;
    if (key !== null && key === loaded) return;
    const contents =
      ready && sides ? highlightKey(repoRoot, sides, open, { old: [], new: [] }) : null;
    const oldLines = JSON.stringify(ranges.old);
    const sameContents = contents !== null && contents === loadedContents;
    const keepOld = sameContents && oldLines === loadedOld && oldSide.value !== null;
    serial += 1;
    const mine = serial;
    cancelInFlight();
    loaded = key;
    loadedContents = contents;
    loadedOld = oldLines;
    if (!sameContents) {
      oldSide.value = null;
      newSide.value = null;
    }
    if (!repoRoot || !sides) return;
    const ask = async (side: Side, which: "old" | "new") => {
      if (!side) return null;
      const opId = newOpId("hl");
      inFlight.push(opId);
      try {
        return await ipc.highlightFile(repoRoot, side.at, side.path, ranges[which], opId);
      } catch {
        return null;
      } finally {
        inFlight = inFlight.filter((id) => id !== opId);
      }
    };
    const kept = oldSide.value;
    const [older, newer] = await Promise.all([
      keepOld ? Promise.resolve(kept) : ask(sides.old, "old"),
      ask(sides.new, "new"),
    ]);
    if (mine !== serial) return;
    oldSide.value = older;
    newSide.value = newer;
  }

  /** Asks again whatever the key: a failed load, or contents the key cannot see change. */
  function reload(): Promise<void> {
    loaded = null;
    loadedContents = null;
    return load();
  }

  // The file object changes whenever the change set reloads; the key decides whether that
  // asks again.
  watch([root, () => target.value, file, hunks, enabled, unchanged], () => void load(), {
    immediate: true,
  });

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

  return { tokens, tokensOf, reload };
}
