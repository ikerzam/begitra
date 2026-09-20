// Lazy highlighting of the open file: once the rows are on screen, the token classes of both
// sides are asked for (cached per blob on the backend) and applied to the rendered segments;
// a file change cancels what is in flight, and a failure leaves the rows plain.

import { computed, ref, watch, type Ref } from "vue";

import * as ipc from "@/ipc/commands";
import { newOpId } from "@/ipc/invoke";
import type { BlobAt, DiffLine, FileChange, Highlight, Token } from "@/ipc/schemas";
import type { ReviewTarget } from "@/stores/review";

import { fileSides } from "./sides";

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

  async function load(): Promise<void> {
    serial += 1;
    const mine = serial;
    oldSide.value = null;
    newSide.value = null;
    const repoRoot = root.value;
    const current = target.value;
    const open = file.value;
    if (!enabled.value || !repoRoot || !current || !open || open.isBinary) return;
    const sides = fileSides(current, open);
    const ask = async (side: { at: BlobAt; path: string } | null) => {
      if (!side) return null;
      try {
        return await ipc.highlightFile(repoRoot, side.at, side.path, newOpId("hl"));
      } catch {
        return null;
      }
    };
    const [older, newer] = await Promise.all([ask(sides.old), ask(sides.new)]);
    if (mine !== serial) return;
    oldSide.value = older;
    newSide.value = newer;
  }

  watch([root, () => target.value, () => file.value?.path, enabled], () => void load(), {
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

  return { tokens, tokensOf, reload: load };
}
