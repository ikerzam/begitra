// The changed symbols of the open file: the declarations of its new side whose lines the
// diff touches, in document order, with the row of each one's first changed line so `]`
// and `[` can land on it. A file without a grammar, or a deleted one, has none.

import { computed, ref, watch, type Ref } from "vue";

import * as ipc from "@/ipc/commands";
import { newOpId } from "@/ipc/invoke";
import type { FileChange, Symbol as FileSymbol } from "@/ipc/schemas";
import type { ReviewTarget } from "@/stores/review";

import type { DiffRowModel } from "./diffRows";
import { fileSides } from "./sides";

export interface ChangedSymbol {
  symbol: FileSymbol;
  /** Index of the first row inside the symbol that adds or removes a line. */
  row: number;
}

/** The new-side line an added row touches. */
function addedLineOf(row: DiffRowModel): number | null {
  if (row.kind === "hunk") return null;
  const line = row.kind === "line" ? row.line : row.right;
  return line?.kind === "added" && line.newNumber !== null ? line.newNumber : null;
}

/** Whether the row only removes (a removed line with no added partner). */
function removesOnly(row: DiffRowModel): boolean {
  if (row.kind === "line") return row.line.kind === "removed";
  return row.kind === "pair" && row.left?.kind === "removed" && row.right === null;
}

/** Where a removed-only row sits on the new side: just after the previous new-side line. */
function removedPosition(rows: DiffRowModel[], index: number): number | null {
  for (let i = index; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row) break;
    // At the hunk's start the removal sits where the hunk starts on the new side.
    if (row.kind === "hunk") return row.hunk.newStart;
    const line = row.kind === "line" ? row.line : (row.right ?? row.left);
    if (line?.newNumber !== null && line?.newNumber !== undefined) return line.newNumber;
  }
  return null;
}

/** Pairs the symbols with the rows that change them. */
export function changedSymbols(symbols: FileSymbol[], rows: DiffRowModel[]): ChangedSymbol[] {
  const changes: { line: number; row: number }[] = [];
  for (const [index, row] of rows.entries()) {
    const added = addedLineOf(row);
    if (added !== null) changes.push({ line: added, row: index });
    else if (removesOnly(row)) {
      const position = removedPosition(rows, index);
      if (position !== null) changes.push({ line: position, row: index });
    }
  }
  const result: ChangedSymbol[] = [];
  for (const symbol of symbols) {
    const first = changes.find(
      (change) => change.line >= symbol.startLine && change.line <= symbol.endLine,
    );
    if (first) result.push({ symbol, row: first.row });
  }
  return result.sort((a, b) => a.symbol.startLine - b.symbol.startLine);
}

export function useSymbols(
  root: Ref<string | null>,
  target: Ref<ReviewTarget | null>,
  file: Ref<FileChange | null>,
  rows: Ref<DiffRowModel[]>,
) {
  const symbols = ref<FileSymbol[]>([]);
  let serial = 0;
  let inFlight: string | null = null;

  async function load(): Promise<void> {
    serial += 1;
    const mine = serial;
    if (inFlight) void ipc.cancelOperation(inFlight).catch(() => undefined);
    inFlight = null;
    symbols.value = [];
    const repoRoot = root.value;
    const current = target.value;
    const open = file.value;
    if (!repoRoot || !current || !open || open.isBinary) return;
    const side = fileSides(current, open).new;
    if (!side) return;
    const opId = newOpId("sym");
    inFlight = opId;
    try {
      const listed = await ipc.fileSymbols(repoRoot, side.at, side.path, opId);
      if (mine === serial) symbols.value = listed;
    } catch {
      // No symbols for this file: the keys do nothing.
    } finally {
      if (inFlight === opId) inFlight = null;
    }
  }

  // The file object changes whenever the change set reloads, so an edit that keeps the
  // path asks again.
  watch([root, () => target.value, file], () => void load(), { immediate: true });

  const changed = computed(() => changedSymbols(symbols.value, rows.value));

  return { symbols, changed, reload: load };
}

/** What the symbol jumps need from the virtual list: where rows sit and how to get there. */
export interface SymbolViewport {
  scrollTop: Ref<number>;
  rowTop: (index: number) => number;
  scrollToRow: (index: number) => void;
}

/**
 * The next (`step` 1) or previous (`-1`) changed symbol from the row at the top of the
 * viewport; scrolls to it and returns its name, or null when the file has none.
 */
export function jumpToSymbol(
  changed: ChangedSymbol[],
  viewport: SymbolViewport,
  step: 1 | -1,
): string | null {
  if (changed.length === 0) return null;
  const top = viewport.scrollTop.value;
  let index = -1;
  if (step > 0) {
    index = changed.findIndex((entry) => viewport.rowTop(entry.row) > top + 1);
    if (index < 0) index = 0;
  } else {
    index = changed.length - 1;
    for (let i = changed.length - 1; i >= 0; i -= 1) {
      if (viewport.rowTop(changed[i]!.row) < top - 1) {
        index = i;
        break;
      }
    }
  }
  const entry = changed[index];
  if (!entry) return null;
  viewport.scrollToRow(entry.row);
  return entry.symbol.name;
}
