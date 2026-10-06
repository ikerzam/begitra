// The commit graph's filters and counts: the text, scope, author, date range and path the bar
// shows, turned into the walk scope and filter the repo store restarts with; the authors seen
// in the loaded commits; the count of the scope for the "N of M commits" line; the two
// commits pinned as chips (kept in the review store); and a file's history, the graph shown
// filtered by its path.

import { defineStore } from "pinia";
import { computed, nextTick, ref, watch } from "vue";

import * as ipc from "@/ipc/commands";
import type { CommitCount, CommitNode, WalkFilter, WalkScope } from "@/ipc/schemas";
import { sameFolder } from "@/shell/format";

import { useProjectsStore } from "./projects";
import { useRepoStore } from "./repo";
import { useReviewStore } from "./review";
import { useShellStore } from "./shell";

export type GraphScope =
  { kind: "all" } | { kind: "current" } | { kind: "ref"; name: string; fullName: string };

export type DateRange = "any" | "7d" | "30d" | "3m" | "1y";

export const DATE_RANGES: readonly DateRange[] = ["any", "7d", "30d", "3m", "1y"];

/** Days each range reaches back. */
const RANGE_DAYS: Record<Exclude<DateRange, "any">, number> = {
  "7d": 7,
  "30d": 30,
  "3m": 90,
  "1y": 365,
};

export interface GraphFilters {
  text: string;
  scope: GraphScope;
  /** Author name as the engine matches it (name or email, case-insensitive); empty for anyone. */
  author: string;
  dateRange: DateRange;
  /** Repository-relative file or directory; empty for none. */
  path: string;
}

export interface AuthorSeen {
  name: string;
  email: string;
  count: number;
}

function defaultFilters(): GraphFilters {
  return { text: "", scope: { kind: "all" }, author: "", dateRange: "any", path: "" };
}

/** A path as git names it: backslashes (typed on Windows) are slashes, no trailing one. */
function gitPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function scopeKey(scope: WalkScope): string {
  return JSON.stringify(scope);
}

export const useGraphStore = defineStore("graph", () => {
  const repo = useRepoStore();
  const review = useReviewStore();
  const shell = useShellStore();

  const filters = ref<GraphFilters>(defaultFilters());
  /** Authors of the commits loaded since the repository opened, keyed by name. */
  const authors = ref<Map<string, AuthorSeen>>(new Map());
  /** Commits in the scope before the filters, once counted. */
  const total = ref<CommitCount | null>(null);
  let countedScope = "";
  /** The history listing the count was made for (`repo.historyVersion`). */
  let countedVersion = -1;
  let countRequest = 0;
  let authorsSeenUpTo = 0;

  /** Whether a filter narrows the scope (the count line and the empty state depend on it). */
  const isFiltered = computed(() => {
    const f = filters.value;
    return f.text.trim() !== "" || f.author !== "" || f.dateRange !== "any" || f.path !== "";
  });
  /** Whether any control differs from its default, including the scope ("Clear" shows). */
  const isActive = computed(() => isFiltered.value || filters.value.scope.kind !== "all");
  /** Loaded commits of the current walk; exact once the walk is done. */
  const matches = computed(() => repo.commits.length);

  function toWalkScope(scope: GraphScope): WalkScope {
    switch (scope.kind) {
      case "all":
        return { kind: "all" };
      case "current":
        return { kind: "ref", name: repo.repo?.currentBranch ?? "HEAD" };
      case "ref":
        return { kind: "ref", name: scope.fullName };
    }
  }

  const walkScope = computed<WalkScope>(() => toWalkScope(filters.value.scope));

  const walkFilter = computed<WalkFilter | undefined>(() => {
    const f = filters.value;
    const filter: WalkFilter = {};
    const text = f.text.trim();
    if (text !== "") filter.text = text;
    if (f.author !== "") filter.author = f.author;
    if (f.dateRange !== "any") {
      filter.since = Math.floor(Date.now() / 1000) - RANGE_DAYS[f.dateRange] * 86_400;
    }
    if (f.path !== "") filter.paths = [f.path];
    return Object.keys(filter).length > 0 ? filter : undefined;
  });

  const authorList = computed(() =>
    [...authors.value.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  );

  const diffBase = computed(() => review.diffBase);
  const rangeEnd = computed(() => review.rangeEnd);

  /** Restarts the walk; `selectHash` as `repo.restartWalk` takes it, the selection by default. */
  function apply(selectHash?: string | null): void {
    repo.restartWalk(walkScope.value, walkFilter.value, selectHash);
  }

  function setText(text: string): void {
    if (filters.value.text === text) return;
    filters.value = { ...filters.value, text };
    apply();
  }

  /** Records the scope; the walk restarts only when it lists something else. */
  function setScope(scope: GraphScope): void {
    const sameWalk = scopeKey(walkScope.value) === scopeKey(toWalkScope(scope));
    filters.value = { ...filters.value, scope };
    if (!sameWalk) apply();
  }

  function setAuthor(author: string): void {
    if (filters.value.author === author) return;
    filters.value = { ...filters.value, author };
    apply();
  }

  function setDateRange(dateRange: DateRange): void {
    if (filters.value.dateRange === dateRange) return;
    filters.value = { ...filters.value, dateRange };
    apply();
  }

  /** A repository-relative path; backslashes (typed on Windows) are git's slashes. */
  function setPath(path: string): void {
    const trimmed = gitPath(path);
    if (filters.value.path === trimmed) return;
    filters.value = { ...filters.value, path: trimmed };
    apply();
  }

  /** Every control back to its default, the scope included. */
  function clear(): void {
    if (!isActive.value) return;
    filters.value = defaultFilters();
    apply();
  }

  /**
   * A file's history: the graph filtered by `path` alone, the text, author and date cleared
   * (left there, they would hide commits of the file unsaid) and the scope kept. The path is
   * git's own (a file's), taken as it is. A `root` other than the open repository's is shown
   * first, as its "Open repository" does, and starts from its own filters; when it fails to
   * open, the graph shows the error, unless another open came after it.
   */
  async function showHistory(path: string, root: string | null = null): Promise<void> {
    const fromGraph = shell.layoutMode === "graph";
    if (root !== null && !isOpen(root)) {
      await useProjectsStore().show(root);
      // The root's watcher below clears the filters of the repository that opened.
      await nextTick();
      if (!isOpen(root)) {
        const state = repo.state;
        if (state.kind === "error" && sameFolder(state.path, root)) {
          await shell.setLayoutMode("graph");
        }
        return;
      }
    }
    const current = filters.value;
    const next: GraphFilters = { ...defaultFilters(), scope: current.scope, path };
    const unchanged =
      current.text === next.text &&
      current.author === next.author &&
      current.dateRange === next.dateRange &&
      current.path === next.path;
    if (!unchanged) {
      filters.value = next;
      // From another layout the selected commit rarely touches the file: the first row is
      // selected at once rather than after up to four pages looking for it.
      apply(fromGraph ? undefined : null);
    }
    await shell.setLayoutMode("graph");
  }

  function isOpen(root: string): boolean {
    const open = repo.repo?.root;
    return open !== undefined && sameFolder(open, root);
  }

  /** The pins drive the review target: `base..end` (HEAD without an end); none follows the selection. */
  function syncTarget(): void {
    const base = review.diffBase;
    if (base) {
      review.setTarget({
        kind: "range",
        from: base,
        to: review.rangeEnd ?? "HEAD",
        threeDot: false,
      });
    } else if (review.chosenTarget?.kind === "range") {
      review.setTarget(null);
    }
  }

  function setDiffBase(hash: string | null): void {
    review.setDiffBase(hash);
    syncTarget();
  }

  function setRangeEnd(hash: string | null): void {
    review.setRangeEnd(hash);
    syncTarget();
  }

  function noteAuthors(commits: CommitNode[], from: number): void {
    const next = new Map(authors.value);
    for (let i = from; i < commits.length; i += 1) {
      const commit = commits[i];
      if (!commit) continue;
      const { name, email } = commit.author;
      const seen = next.get(name);
      next.set(name, seen ? { ...seen, count: seen.count + 1 } : { name, email, count: 1 });
    }
    authors.value = next;
  }

  // Immediate, like the count below: the store may be created after the repository opened.
  watch(
    () => repo.commits,
    (commits) => {
      if (commits.length < authorsSeenUpTo) authorsSeenUpTo = 0;
      if (commits.length > authorsSeenUpTo) noteAuthors(commits, authorsSeenUpTo);
      authorsSeenUpTo = commits.length;
    },
    { immediate: true },
  );

  // The scope is counted once its walk has answered a first page, off the first-paint path, and
  // again once the history is listed again after a move (a commit, a fetch); the last count
  // shows until the new one arrives.
  watch(
    () =>
      [
        repo.repo?.root,
        repo.walk !== null,
        scopeKey(walkScope.value),
        repo.historyVersion,
      ] as const,
    ([root, started, scope, version]) => {
      if (!root || !started || (scope === countedScope && version === countedVersion)) return;
      if (scope !== countedScope) total.value = null;
      countedScope = scope;
      countedVersion = version;
      countRequest += 1;
      const request = countRequest;
      ipc
        .countCommits(root, walkScope.value)
        .then((count) => {
          if (request === countRequest) total.value = count;
        })
        .catch(() => {
          // The line shows the matches alone; the count is retried on the next scope change.
          if (request === countRequest) countedScope = "";
        });
    },
    { immediate: true },
  );

  // HEAD switched branch (here or in a terminal) while the graph shows the current branch:
  // the walk lists the new one. Another repository resets the filters instead.
  watch(
    () =>
      [
        repo.repo?.root,
        filters.value.scope.kind === "current" ? scopeKey(walkScope.value) : null,
      ] as const,
    ([root, key], [rootBefore, keyBefore]) => {
      if (root !== rootBefore || key === null || keyBefore === null || key === keyBefore) return;
      apply();
    },
  );

  // Another repository: every filter, the authors, the count and the pins start over.
  watch(
    () => repo.repo?.root,
    () => {
      filters.value = defaultFilters();
      authors.value = new Map();
      authorsSeenUpTo = 0;
      total.value = null;
      countedScope = "";
      countedVersion = -1;
      countRequest += 1;
      review.clearPins();
    },
  );

  return {
    filters,
    isFiltered,
    isActive,
    matches,
    total,
    authors,
    authorList,
    walkScope,
    walkFilter,
    diffBase,
    rangeEnd,
    setText,
    setScope,
    setAuthor,
    setDateRange,
    setPath,
    clear,
    showHistory,
    setDiffBase,
    setRangeEnd,
  };
});
