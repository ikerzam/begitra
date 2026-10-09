// The conflict blocks of the conflicted file the changes screen shows: read from the working
// tree, one block written at a time (a side, both, or the text of an edit), each write with an
// Undo in its toast that puts the block back while the file is the one the write left. A file
// changed on disk since it was read (saved in the editor) is read again, never overwritten, and
// a block being edited follows its lines there or ends with its text kept in a toast. "No
// conflict left" is said only of a file whose blocks were written here: a file read without a
// block (resolved in the editor, or a conflict git wrote no marker for) keeps the card.

import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { sideParams } from "@/branches/sides";
import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type {
  BlockResolution,
  BlockUndo,
  ConflictBlock,
  ConflictText,
  RepoChanged,
  SideName,
} from "@/ipc/schemas";
import { errorText } from "@/shell/errorMessage";
import { baseName } from "@/shell/format";

import { useOperationsStore } from "./operations";
import { useSequencerStore } from "./sequencer";
import { useToastsStore } from "./toasts";

/** Where the reading of the file stands: `unreadable` keeps the whole-file card. */
export type BlocksState = "idle" | "loading" | "ready" | "unreadable" | "failed";

/** The toast slot of a block's write: only the last one can be undone. */
const UNDO_SLOT = "conflict-block";

/** A block's two sides as text: how an edit finds its block again after the file is read. */
function signatureOf(text: ConflictText, block: ConflictBlock): string {
  return [
    ...text.lines.slice(block.ours.start, block.ours.end),
    "\u0000",
    ...text.lines.slice(block.theirs.start, block.theirs.end),
  ].join("\n");
}

export const useConflictBlocksStore = defineStore("conflictBlocks", () => {
  const toasts = useToastsStore();
  const operations = useOperationsStore();
  const sequencer = useSequencerStore();

  const root = ref<string | null>(null);
  const path = ref<string | null>(null);
  const text = ref<ConflictText | null>(null);
  const state = ref<BlocksState>("idle");
  const error = ref<AppError | null>(null);
  const busy = ref(false);
  /** The block the keys act on. */
  const focused = ref(0);
  /** The block turned into a text field, and the field's text. */
  const editing = ref<number | null>(null);
  const draft = ref("");
  /** The edited block's sides when the edit began. */
  let editSignature: string | null = null;
  /** The files whose blocks were all written here, by root and path. */
  const resolvedHere = new Set<string>();
  /** The toast holding the last write's Undo, and the file it belongs to. */
  let undoToast: { id: number; root: string; path: string } | null = null;
  let serial = 0;

  const blocks = computed(() =>
    state.value === "ready" && text.value !== null ? text.value.blocks : [],
  );
  /** Every block of the file was written here: "Mark resolved" is next. */
  const noneLeft = computed(
    () => state.value === "ready" && text.value !== null && text.value.blocks.length === 0,
  );

  const keyOf = (at: string, file: string) => `${at}\u0000${file}`;

  /** Shows the blocks of `nextPath` in `nextRoot`, read again unless they show already. */
  function show(nextRoot: string, nextPath: string): void {
    if (root.value === nextRoot && path.value === nextPath && state.value !== "idle") return;
    root.value = nextRoot;
    path.value = nextPath;
    text.value = null;
    error.value = null;
    focused.value = 0;
    endEdit();
    void read();
  }

  /** Nothing shows: answers still on their way are dropped. */
  function close(): void {
    serial += 1;
    root.value = null;
    path.value = null;
    text.value = null;
    state.value = "idle";
    endEdit();
  }

  /** Reads the file again; the blocks shown stay until the answer replaces them. */
  async function read(): Promise<void> {
    const at = root.value;
    const file = path.value;
    if (!at || !file) return;
    const mine = ++serial;
    if (text.value === null) state.value = "loading";
    try {
      const read = await ipc.conflictBlocks(at, file);
      if (mine !== serial) return;
      take(read);
      error.value = null;
    } catch (failure) {
      if (mine !== serial) return;
      const failed = toAppError(failure);
      error.value = failed;
      text.value = null;
      endEdit();
      const card =
        failed.code === "conflict.unreadable" || failed.code === "conflict.not_conflicted";
      state.value = card ? "unreadable" : "failed";
    }
  }

  /** Shows `read`: a file without a block is "no conflict left" only when this view wrote its
   * last one; an edit follows its block, or ends with its text in a toast. */
  function take(read: ConflictText): void {
    const at = root.value;
    const file = path.value;
    const doneHere = at !== null && file !== null && resolvedHere.has(keyOf(at, file));
    if (read.blocks.length > 0 && at !== null && file !== null)
      resolvedHere.delete(keyOf(at, file));
    text.value = read;
    state.value = read.paired && (read.blocks.length > 0 || doneHere) ? "ready" : "unreadable";
    focused.value = Math.min(focused.value, Math.max(0, read.blocks.length - 1));
    if (editing.value === null || editSignature === null) return;
    const anchor = editSignature;
    const found = read.blocks.findIndex((block) => signatureOf(read, block) === anchor);
    if (found >= 0) {
      editing.value = found;
      focused.value = found;
      return;
    }
    const lost = draft.value;
    endEdit();
    toasts.push({
      kind: "info",
      message: "",
      key: "conflictBlocks.editLost",
      params: { file: baseName(file ?? "") },
      actionKey: "conflictBlocks.showText",
      output: lost,
      sticky: true,
    });
  }

  function endEdit(): void {
    editing.value = null;
    draft.value = "";
    editSignature = null;
  }

  /** Whether the answer of a write on `at`/`file` still belongs to what shows. */
  function showing(at: string, file: string): boolean {
    return root.value === at && path.value === file;
  }

  /** Writes block `index` with `resolution`; its toast offers Undo. While a block is edited,
   * only that block is written. */
  async function resolve(index: number, resolution: BlockResolution): Promise<boolean> {
    const at = root.value;
    const file = path.value;
    const current = text.value;
    if (!at || !file || !current || busy.value || !current.blocks[index]) return false;
    if (editing.value !== null && (resolution.kind !== "text" || editing.value !== index)) {
      return false;
    }
    if (resolution.kind === "text" && !current.utf8) return false;
    busy.value = true;
    const opId = newOpId("conflict-block");
    operations.start(opId, "operations.writingConflictBlock", undefined, {
      params: { file: baseName(file) },
    });
    try {
      const done = await ipc.resolveConflictBlock(
        at,
        file,
        current.fingerprint,
        index,
        resolution,
        opId,
      );
      if (done.file.blocks.length === 0) resolvedHere.add(keyOf(at, file));
      if (showing(at, file)) {
        endEdit();
        focused.value = index;
        take(done.file);
      }
      offerUndo(at, file, index, resolution, done.undo);
      return true;
    } catch (failure) {
      report(failure, file, index, "conflictBlocks.failed");
      if (showing(at, file)) await read();
      return false;
    } finally {
      operations.finish(opId);
      busy.value = false;
    }
  }

  /** The names a toast gives the side taken. */
  function sideKey(side: SideName | undefined, fallback: "current" | "incoming") {
    return side
      ? { key: `conflictBlocks.used.${side.kind}`, params: sideParams(side) }
      : { key: `conflictBlocks.used.${fallback}`, params: {} };
  }

  function closeUndo(): void {
    if (undoToast !== null) toasts.dismiss(undoToast.id);
    undoToast = null;
  }

  function offerUndo(
    at: string,
    file: string,
    index: number,
    resolution: BlockResolution,
    token: BlockUndo,
  ): void {
    const named = sequencer.sides;
    const said =
      resolution.kind === "ours"
        ? sideKey(named?.ours, "current")
        : resolution.kind === "theirs"
          ? sideKey(named?.theirs, "incoming")
          : {
              key: `conflictBlocks.${resolution.kind === "both" ? "usedBoth" : "edited"}`,
              params: {},
            };
    const id = toasts.push({
      kind: "success",
      message: "",
      key: said.key,
      params: { ...said.params, n: index + 1, file: baseName(file) },
      actionKey: "sequencer.side.undo",
      onAction: () => {
        undoToast = null;
        void undo(at, file, token, index);
      },
      onDismiss: () => {
        if (undoToast?.id === id) undoToast = null;
      },
      // The block's markers come back only through this Undo.
      sticky: true,
      slot: UNDO_SLOT,
    });
    undoToast = { id, root: at, path: file };
  }

  /** Undo of a block written: the block comes back with its markers. */
  async function undo(at: string, file: string, token: BlockUndo, index: number): Promise<boolean> {
    if (busy.value) return false;
    busy.value = true;
    const opId = newOpId("conflict-block-undo");
    operations.start(opId, "operations.undoingConflictBlock", undefined, {
      params: { file: baseName(file) },
    });
    try {
      const back = await ipc.undoConflictBlock(at, file, token, opId);
      resolvedHere.delete(keyOf(at, file));
      if (showing(at, file)) {
        focused.value = index;
        take(back);
      }
      return true;
    } catch (failure) {
      report(failure, file, index, "conflictBlocks.undoFailed");
      if (showing(at, file)) await read();
      return false;
    } finally {
      operations.finish(opId);
      busy.value = false;
    }
  }

  /** A refused write or Undo in a toast that names the block and the file, git's words behind
   * it; a file changed on disk says so in its own sentence. */
  function report(failure: unknown, file: string, index: number, fallback: string): void {
    const failed = toAppError(failure);
    const said = errorText(failed, baseName(file));
    const generic = said.key === "errors.gitFailed" || said.key === "errors.generic";
    toasts.push({
      kind: failed.code === "conflict.file_changed" ? "info" : "error",
      message: "",
      key: generic ? fallback : said.key,
      params: { ...said.params, n: index + 1, file: baseName(file), message: failed.message },
      output: failed.detail ?? failed.message,
    });
  }

  /** Turns block `index` into a text field: the current side's lines, then the incoming
   * side's, without the markers. A file that is not UTF-8 says why it cannot. */
  function startEdit(index: number): void {
    const current = text.value;
    const block = current?.blocks[index];
    if (!current || !block || busy.value || editing.value !== null) return;
    if (!current.utf8) {
      toasts.push({ kind: "info", message: "", key: "conflictBlocks.notUtf8" });
      return;
    }
    const lines = [
      ...current.lines.slice(block.ours.start, block.ours.end),
      ...current.lines.slice(block.theirs.start, block.theirs.end),
    ];
    draft.value = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    editSignature = signatureOf(current, block);
    editing.value = index;
    focused.value = index;
  }

  /** Leaves the block as it was. */
  function cancelEdit(): void {
    endEdit();
  }

  /** Writes the field's text in the block's place. */
  async function applyEdit(): Promise<boolean> {
    if (editing.value === null) return false;
    return resolve(editing.value, { kind: "text", text: draft.value });
  }

  /** Moves the focus `step` blocks, within the list. */
  function move(step: number): void {
    const count = blocks.value.length;
    if (count === 0) return;
    focused.value = Math.min(count - 1, Math.max(0, focused.value + step));
  }

  /** The watcher: the file shown changed on disk (an editor, a terminal), so it reads again. */
  function onRepoChanged(change: RepoChanged): void {
    const file = path.value;
    if (!file || change.repo !== root.value || busy.value) return;
    if (!change.kinds.includes("status")) return;
    if (change.paths.length > 0 && !change.paths.includes(file)) return;
    void read();
  }

  // An Undo whose file left the conflicts (marked resolved, the operation finished or aborted)
  // would only fail: its toast goes.
  watch(
    () => sequencer.conflicts,
    (conflicts) => {
      const held = undoToast;
      if (held && !conflicts.some((conflict) => conflict.path === held.path)) closeUndo();
    },
  );

  return {
    root,
    path,
    text,
    state,
    error,
    busy,
    focused,
    editing,
    draft,
    blocks,
    noneLeft,
    show,
    close,
    read,
    resolve,
    undo,
    startEdit,
    cancelEdit,
    applyEdit,
    move,
    onRepoChanged,
  };
});
