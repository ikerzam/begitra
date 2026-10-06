// The find in the diff: the bar (open, the query, "Match case"), the matches over the files of
// the viewer that shows it, counted 150 ms after the query changes in slices that never hold the
// window for more than 8 ms, and the current match, which next and previous move across files.
// What it searches comes from the viewer on screen (`attach`): the review's and the comparison's
// files panel, or the Changes screen's viewer. Typing never leaves the open file: a query with no
// match there counts without a place until next or previous moves.

import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";

import { matchFile, type FindFile, type FindMatch } from "@/review/find";

/** What the find searches: the files a viewer lists, in its order. */
export interface FindSource {
  /** The files in the viewer's order, each with the hunks its diff shows. */
  files: () => FindFile[];
  /**
   * Shows a file in the viewer as a click on its row does, past its card; asked for every
   * match it brings into view, the open file's too, so it does nothing more than needed.
   */
  open: (file: FindFile) => void;
  /** The key of the file the viewer shows. */
  shownKey: () => string | null;
  /** Whether the viewer's files are still being read (pages streaming, a reload). */
  loading?: () => boolean;
}

/** The wait after a keystroke before the matches are counted again. */
export const FIND_WAIT_MS = 150;
/** The longest the counting holds the main thread at a time. */
export const FIND_SLICE_MS = 8;
/** The count stops here: a query of one letter over a large change set would list millions. */
export const FIND_LIMIT = 10_000;

type Reason = "query" | "files";

/** Where a match sits in the viewer's order: its file's place, then hunk, line and offset. */
function rank(match: FindMatch, order: Map<string, number>): [number, number, number, number] {
  return [order.get(match.key) ?? -1, match.hunk, match.line, match.start];
}

function isAfter(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export const useFindStore = defineStore("find", () => {
  const open = ref(false);
  const query = ref("");
  const matchCase = ref(false);
  /** The query the bar last closed with, which ⌘F and F3 come back to. */
  const lastQuery = ref("");
  const source = shallowRef<FindSource | null>(null);
  const matches = shallowRef<FindMatch[]>([]);
  /** Each file's matches, by key, for its rows. */
  const byKey = shallowRef(new Map<string, FindMatch[]>());
  /** Whether the count stopped at the limit. */
  const capped = ref(false);
  /** The current match's index; -1 before next or previous gives one a place. */
  const current = ref(-1);
  /** A count is waiting for the typing to stop or is running. */
  const counting = ref(false);
  /** Bumped to ask the bar's field for the focus. */
  const focusRequest = ref(0);
  /** Bumped to ask the viewer to bring the current match into view. */
  const revealRequest = ref(0);

  const count = computed(() => matches.value.length);
  const currentMatch = computed<FindMatch | null>(() => matches.value[current.value] ?? null);
  /** Nothing is final yet: a count waits or runs, or the viewer still reads its files. */
  const pending = computed(() => counting.value || (source.value?.loading?.() ?? false));

  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Why the next count runs: a new query places the current match afresh, new files keep it. */
  let reason: Reason | null = null;
  /** Why the count under way runs. */
  let running: Reason | null = null;
  /** The query came from `show`, which counts without the typing wait. */
  let shown = false;
  /** The current match as last placed, kept through counts that lose it until the query changes. */
  let anchor: FindMatch | null = null;
  /** A move asked for while a new query was still being counted, made once it is. */
  let pendingMove: 1 | -1 | 0 = 0;

  function schedule(why: Reason, delay = FIND_WAIT_MS): void {
    if (why === "query" || reason === null) reason = why;
    counting.value = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      countMatches();
    }, delay);
  }

  /** Counts the matches over the viewer's files, a slice at a time. */
  function countMatches(): void {
    generation += 1;
    const mine = generation;
    const why = reason ?? "files";
    reason = null;
    running = why;
    counting.value = true;
    const files = source.value?.files() ?? [];
    const text = open.value ? query.value : "";
    if (text === "" || files.length === 0) {
      finish(mine, why, [], false, files);
      return;
    }
    const found: FindMatch[] = [];
    let index = 0;
    const step = (): void => {
      if (mine !== generation) return;
      const deadline = performance.now() + FIND_SLICE_MS;
      while (index < files.length && found.length < FIND_LIMIT) {
        const file = files[index];
        index += 1;
        if (file) {
          for (const match of matchFile(file, text, matchCase.value)) {
            if (found.length >= FIND_LIMIT) break;
            found.push(match);
          }
        }
        if (performance.now() >= deadline) break;
      }
      if (index < files.length && found.length < FIND_LIMIT) setTimeout(step, 0);
      else finish(mine, why, found, found.length >= FIND_LIMIT, files);
    };
    step();
  }

  function finish(
    mine: number,
    why: Reason,
    found: FindMatch[],
    stopped: boolean,
    files: FindFile[],
  ): void {
    if (mine !== generation) return;
    const keyed = new Map<string, FindMatch[]>();
    for (const match of found) {
      const list = keyed.get(match.key);
      if (list) list.push(match);
      else keyed.set(match.key, [match]);
    }
    matches.value = found;
    byKey.value = keyed;
    capped.value = stopped;
    running = null;
    counting.value = timer !== undefined;
    const order = new Map(files.map((file, i) => [file.key, i]));
    if (why === "query") {
      anchor = null;
      current.value = firstInShown(found);
      if (current.value >= 0) anchor = found[current.value] ?? null;
      const move = pendingMove;
      pendingMove = 0;
      if (move !== 0 && current.value < 0) step(move, order);
      else if (current.value >= 0) reveal();
      return;
    }
    current.value = relocate(found, order);
    if (current.value >= 0) anchor = found[current.value] ?? null;
  }

  /** The open file's first match, or -1. */
  function firstInShown(found: FindMatch[]): number {
    const shownKey = source.value?.shownKey() ?? null;
    return shownKey === null ? -1 : found.findIndex((match) => match.key === shownKey);
  }

  /**
   * The current match after the files were read again: the anchor's line (the same file, text
   * and offset, the nearest if the line repeats), else the first match after where it was;
   * without an anchor, the open file's first match.
   */
  function relocate(found: FindMatch[], order: Map<string, number>): number {
    const was = anchor;
    if (!was) return firstInShown(found);
    let best = -1;
    let distance = Infinity;
    found.forEach((match, index) => {
      if (match.key !== was.key || match.text !== was.text || match.start !== was.start) return;
      const away = Math.abs(match.hunk - was.hunk) * 1_000_000 + Math.abs(match.line - was.line);
      if (away < distance) {
        best = index;
        distance = away;
      }
    });
    if (best >= 0) return best;
    const at = rank(was, order);
    const next = found.findIndex((match) => isAfter(rank(match, order), at));
    return next >= 0 ? next : found.length > 0 ? 0 : -1;
  }

  /** Shows the current match's file (past its card) and asks for its line in view. */
  function reveal(): void {
    const match = currentMatch.value;
    const viewer = source.value;
    if (!match || !viewer) return;
    const file = viewer.files().find((entry) => entry.key === match.key);
    if (file) viewer.open(file);
    revealRequest.value += 1;
  }

  /** Moves the current match by `by`; without one, from the open file. */
  function step(by: 1 | -1, order: Map<string, number>): void {
    const total = matches.value.length;
    if (total === 0) return;
    const at = current.value;
    if (at >= 0) {
      current.value = (at + by + total) % total;
    } else {
      const shownKey = source.value?.shownKey() ?? null;
      const place = shownKey === null ? -1 : (order.get(shownKey) ?? -1);
      const found = matches.value;
      if (by > 0) {
        const later = found.findIndex((match) => (order.get(match.key) ?? -1) > place);
        current.value = later >= 0 ? later : 0;
      } else {
        let earlier = -1;
        found.forEach((match, index) => {
          if ((order.get(match.key) ?? -1) < place) earlier = index;
        });
        current.value = earlier >= 0 ? earlier : total - 1;
      }
    }
    anchor = matches.value[current.value] ?? null;
    reveal();
  }

  function move(by: 1 | -1): void {
    // A new query still waiting or counting: count it now, then move.
    if (reason === "query" || running === "query") {
      pendingMove = by;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        countMatches();
      }
      return;
    }
    const files = source.value?.files() ?? [];
    step(by, new Map(files.map((file, i) => [file.key, i])));
  }

  /**
   * Opens the bar on `text` (the selection), else on the query it closed with, and counts at
   * once: the wait is for typing.
   */
  function show(text = ""): void {
    const wasOpen = open.value;
    const next = text !== "" ? text : wasOpen ? query.value : lastQuery.value;
    open.value = true;
    focusRequest.value += 1;
    if (next !== query.value) {
      shown = true;
      query.value = next;
    } else if (!wasOpen) {
      schedule("query", 0);
    }
  }

  /** F3 and ⇧F3: the next or previous match, opening the bar on its last query when closed. */
  function next(): void {
    if (open.value) move(1);
    else show();
  }

  function previous(): void {
    if (open.value) move(-1);
    else show();
  }

  function close(): void {
    if (!open.value) return;
    lastQuery.value = query.value;
    open.value = false;
    generation += 1;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    reason = null;
    running = null;
    anchor = null;
    pendingMove = 0;
    matches.value = [];
    byKey.value = new Map();
    capped.value = false;
    counting.value = false;
    current.value = -1;
  }

  function setQuery(text: string): void {
    query.value = text;
  }

  function setMatchCase(on: boolean): void {
    matchCase.value = on;
  }

  /** Makes `viewer` what the find searches; the returned function lets go of it. */
  function attach(viewer: FindSource): () => void {
    source.value = viewer;
    if (open.value) schedule("files", 0);
    return () => {
      if (source.value !== viewer) return;
      source.value = null;
      close();
    };
  }

  watch([query, matchCase], () => {
    if (open.value) schedule("query", shown ? 0 : FIND_WAIT_MS);
    shown = false;
  });
  // The files changed (pages streamed, the working tree read again, a filter of the panel).
  watch(
    () => source.value?.files(),
    () => {
      if (open.value) schedule("files");
    },
  );

  return {
    open,
    query,
    matchCase,
    lastQuery,
    matches,
    byKey,
    capped,
    current,
    count,
    counting,
    pending,
    currentMatch,
    focusRequest,
    revealRequest,
    show,
    close,
    next,
    previous,
    setQuery,
    setMatchCase,
    attach,
  };
});
