// The new side of the open file read whole, for the unchanged lines around its hunks: asked
// once the rows are there, as highlighting is, cancelled when another file opens, and never
// for a file whose hunks leave no line out (binary, added, deleted, or the single hunk "Show
// new file" makes). A reload of the same file keeps the lines read until the new ones
// arrive; they count only while they hold the hunks' lines (`matchesHunks`), so a working
// file edited under an open diff folds its unchanged lines until the reload brings new hunks.

import { computed, ref, shallowRef, watch, type Ref } from "vue";

import * as ipc from "@/ipc/commands";
import { newOpId } from "@/ipc/invoke";
import type { FileChange, Hunk } from "@/ipc/schemas";
import type { ReviewTarget } from "@/stores/review";

import { fileSides } from "./sides";
import { matchesHunks, splitLines } from "./unchanged";

/**
 * Where the new side's lines stand: `ready` (they match the hunks shown), `loading` (being
 * read), `stale` (read, but the file moved since its hunks were computed) or `failed` (not
 * read: an error, a binary side, or nothing to read).
 */
export type NewSideState = "ready" | "loading" | "stale" | "failed";

export function useNewSide(
  root: Ref<string | null>,
  target: Ref<ReviewTarget | null>,
  file: Ref<FileChange | null>,
  /** The hunks shown beside the lines. */
  hunks: Ref<readonly Hunk[]>,
  /** Whether the lines are wanted at all (rows shown, the file's own hunks). */
  enabled: Ref<boolean>,
) {
  /** The lines of the last read, whatever hunks they were read for. */
  const read = shallowRef<string[] | null>(null);
  const loading = ref(false);
  let serial = 0;
  let inFlight: string | null = null;
  /** What the lines read (or being read) are: the side, its id and the file's path. */
  let loaded: string | null = null;
  let loadedPath: string | null = null;

  function cancelInFlight(): void {
    if (inFlight !== null) void ipc.cancelOperation(inFlight).catch(() => undefined);
    inFlight = null;
  }

  async function load(): Promise<void> {
    const repoRoot = root.value;
    const current = target.value;
    const open = file.value;
    const wanted =
      enabled.value &&
      repoRoot !== null &&
      current !== null &&
      open !== null &&
      !open.isBinary &&
      open.status !== "added" &&
      open.status !== "deleted" &&
      hunks.value.length > 0;
    const side = wanted && current && open ? fileSides(current, open).new : null;
    // A side without an id (unread, or too large for the patch) is read again every time.
    const key =
      side && open && open.newId !== null ? JSON.stringify([repoRoot, side, open.newId]) : null;
    if (key !== null && key === loaded) return;
    serial += 1;
    const mine = serial;
    cancelInFlight();
    loaded = key;
    if (!side || !open || repoRoot === null) {
      read.value = null;
      loadedPath = null;
      loading.value = false;
      return;
    }
    if (open.path !== loadedPath) read.value = null;
    loadedPath = open.path;
    loading.value = true;
    const opId = newOpId("side");
    inFlight = opId;
    try {
      const blob = await ipc.readBlob(repoRoot, side.at, side.path, opId);
      if (mine !== serial) return;
      read.value = blob.text === undefined ? null : splitLines(blob.text);
    } catch {
      if (mine === serial) read.value = null;
    } finally {
      if (inFlight === opId) inFlight = null;
      if (mine === serial) loading.value = false;
    }
  }

  // The file object changes whenever the change set lists it again; the key decides whether
  // that reads again.
  watch([root, () => target.value, file, hunks, enabled], () => void load(), {
    immediate: true,
  });

  /** The new side's lines while they match the hunks shown; null otherwise. */
  const lines = computed<readonly string[] | null>(() => {
    const text = read.value;
    return text !== null && matchesHunks(hunks.value, text) ? text : null;
  });

  const state = computed<NewSideState>(() => {
    if (lines.value !== null) return "ready";
    if (loading.value) return "loading";
    return read.value !== null ? "stale" : "failed";
  });

  return { lines, loading, state };
}
