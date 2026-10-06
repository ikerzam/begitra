// The find in the diff: the bar (open, the query, "Match case"), the matches over the files of
// the viewer that shows it, counted 150 ms after the query changes in slices that never hold the
// window for more than 8 ms, and the current match, which next and previous move across files.
// What it searches comes from the viewer on screen (`attach`): the review's and the comparison's
// files panel, or the Changes screen's viewer.

import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";

import { matchFile, type FindFile, type FindMatch } from "@/review/find";

/** What the find searches: the files a viewer lists, in its order. */
export interface FindSource {
  /** The files in the viewer's order, each with the hunks its diff shows. */
  files: () => FindFile[];
  /** Opens a file in the viewer as a click on its row does, showing it past its card. */
  open: (file: FindFile) => void;
  /** The key of the file the viewer shows. */
  shownKey: () => string | null;
}

/** The wait after a keystroke before the matches are counted again. */
export const FIND_WAIT_MS = 150;
/** The longest the counting holds the main thread at a time. */
export const FIND_SLICE_MS = 8;
/** The count stops here: a query of one letter over a large change set would list millions. */
export const FIND_LIMIT = 10_000;

/** Whether match `a` comes after `b`: by its file's place, then hunk, line and offset. */
function after(a: FindMatch, b: FindMatch, order: Map<string, number>): boolean {
  const fa = order.get(a.key) ?? -1;
  const fb = order.get(b.key) ?? -1;
  if (fa !== fb) return fa > fb;
  if (a.hunk !== b.hunk) return a.hunk > b.hunk;
  if (a.line !== b.line) return a.line > b.line;
  return a.start > b.start;
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
  const current = ref(-1);
  const counting = ref(false);
  /** Bumped to ask the bar's field for the focus. */
  const focusRequest = ref(0);
  /** Bumped to ask the viewer to bring the current match into view. */
  const revealRequest = ref(0);

  const count = computed(() => matches.value.length);
  const currentMatch = computed<FindMatch | null>(() => matches.value[current.value] ?? null);

  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Why the next count runs: a new query moves to the open file, new files keep the place. */
  let reason: "query" | "files" = "query";
  /** The query came from `show`, which counts without the typing wait. */
  let shown = false;

  function schedule(why: "query" | "files", delay = FIND_WAIT_MS): void {
    if (why === "query") reason = "query";
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
    const why = reason;
    reason = "files";
    const files = source.value?.files() ?? [];
    const text = open.value ? query.value : "";
    if (text === "" || files.length === 0) {
      finish(mine, why, [], false, files);
      return;
    }
    counting.value = true;
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
    why: "query" | "files",
    found: FindMatch[],
    stopped: boolean,
    files: FindFile[],
  ): void {
    if (mine !== generation) return;
    const previous = currentMatch.value;
    const keyed = new Map<string, FindMatch[]>();
    for (const match of found) {
      const list = keyed.get(match.key);
      if (list) list.push(match);
      else keyed.set(match.key, [match]);
    }
    matches.value = found;
    byKey.value = keyed;
    capped.value = stopped;
    counting.value = false;
    const order = new Map(files.map((file, i) => [file.key, i]));
    current.value = pick(found, why, previous, order);
    if (current.value >= 0 && why === "query") reveal();
  }

  /** The current match after a count. */
  function pick(
    found: FindMatch[],
    why: "query" | "files",
    previous: FindMatch | null,
    order: Map<string, number>,
  ): number {
    if (found.length === 0) return -1;
    if (why === "files" && previous) {
      const same = found.findIndex(
        (m) =>
          m.key === previous.key &&
          m.hunk === previous.hunk &&
          m.line === previous.line &&
          m.start === previous.start,
      );
      if (same >= 0) return same;
      const next = found.findIndex((m) => after(m, previous, order));
      return next >= 0 ? next : 0;
    }
    const shown = source.value?.shownKey() ?? null;
    const inShown = shown === null ? -1 : found.findIndex((m) => m.key === shown);
    if (inShown >= 0) return inShown;
    const shownAt = shown === null ? -1 : (order.get(shown) ?? -1);
    const later = found.findIndex((m) => (order.get(m.key) ?? -1) > shownAt);
    return later >= 0 ? later : 0;
  }

  /** Opens the current match's file when another shows, and asks for its line in view. */
  function reveal(): void {
    const match = currentMatch.value;
    const viewer = source.value;
    if (!match || !viewer) return;
    if (viewer.shownKey() !== match.key) {
      const file = viewer.files().find((entry) => entry.key === match.key);
      if (file) viewer.open(file);
    }
    revealRequest.value += 1;
  }

  function move(step: 1 | -1): void {
    const total = matches.value.length;
    if (total === 0) return;
    const at = current.value;
    current.value = at < 0 ? (step > 0 ? 0 : total - 1) : (at + step + total) % total;
    reveal();
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
