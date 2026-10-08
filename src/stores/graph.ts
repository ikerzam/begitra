// The commit graph's filters and counts: the text, scope, author, date range, path and code
// search the bar shows, turned into the walk scope and filter the repo store restarts with; the
// authors seen in the loaded commits; the count of the scope for the "N of M commits" line; the
// two commits pinned as chips (kept in the review store); a file's history, the graph shown
// filtered by its path; the remote branches hidden from the all-branches walk; and Go to HEAD.

import { defineStore } from "pinia";
import { computed, nextTick, ref, watch } from "vue";

import { patternNames } from "@/graph/scopeRefs";
import * as ipc from "@/ipc/commands";
import {
  MAX_CODE_TEXT,
  MAX_SCOPE_NAMES,
  withoutControlCharacters,
  type CommitCount,
  type CommitNode,
  type WalkFilter,
  type WalkScope,
} from "@/ipc/schemas";
import { sameFolder } from "@/shell/format";

import { useProjectsStore } from "./projects";
import { useRemotesStore } from "./remotes";
import { useRepoStore } from "./repo";
import { useReviewStore } from "./review";
import { useSettingsStore } from "./settings";
import { useShellStore } from "./shell";

export type GraphScope =
  | { kind: "all" }
  | { kind: "current" }
  | { kind: "ref"; name: string; fullName: string }
  /** The branches a glob matches (`scopeRefs.ts`). */
  | { kind: "pattern"; pattern: string };

export type DateRange = "any" | "7d" | "30d" | "3m" | "1y";

export const DATE_RANGES: readonly DateRange[] = ["any", "7d", "30d", "3m", "1y"];

/** Days each range reaches back. */
const RANGE_DAYS: Record<Exclude<DateRange, "any">, number> = {
  "7d": 7,
  "30d": 30,
  "3m": 90,
  "1y": 365,
};

/** A search of what the commits change, the text matched as written. */
export interface CodeSearch {
  text: string;
  /** "On a changed line" (`git log -G`) rather than "Added or removed" (`git log -S`). */
  lines: boolean;
}

export interface GraphFilters {
  text: string;
  scope: GraphScope;
  /** Author name as the engine matches it (name or email, case-insensitive); empty for anyone. */
  author: string;
  dateRange: DateRange;
  /** Repository-relative file or directory; empty for none. */
  path: string;
  /** The code search; null for none. */
  code: CodeSearch | null;
}

export interface AuthorSeen {
  name: string;
  email: string;
  count: number;
}

function defaultFilters(): GraphFilters {
  return { text: "", scope: { kind: "all" }, author: "", dateRange: "any", path: "", code: null };
}

/** A path as git names it: backslashes (typed on Windows) are slashes, no trailing one. */
function gitPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function scopeKey(scope: WalkScope): string {
  return JSON.stringify(scope);
}

/**
 * What Go to HEAD came to: HEAD's commit selected; HEAD left out by the scope or the filters; or
 * nothing to say (HEAD unborn, a walk that failed, the history listed again meanwhile).
 */
export type HeadSearch = "selected" | "outside" | "none";

/**
 * How far past HEAD's commit date Go to HEAD reads the walk before HEAD counts as left out. The
 * walk lists the newest commit dates first, so HEAD comes before every older commit unless dates
 * are skewed; a day covers the clocks of most machines.
 */
const HEAD_SLACK_SECONDS = 86_400;

export const useGraphStore = defineStore("graph", () => {
  const repo = useRepoStore();
  const review = useReviewStore();
  const shell = useShellStore();
  const settings = useSettingsStore();
  const remotes = useRemotesStore();

  /** The remote branches no local branch tracks are left out of the all-branches walk. */
  const hideRemotes = computed(() => settings.values.graphHideRemotes);

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
  /** Bumped by each Go to HEAD: a later one supersedes a search still loading pages. */
  let headSearch = 0;

  /** Whether a filter narrows the scope (the count line and the empty state depend on it). */
  const isFiltered = computed(() => {
    const f = filters.value;
    return (
      f.text.trim() !== "" ||
      f.author !== "" ||
      f.dateRange !== "any" ||
      f.path !== "" ||
      f.code !== null
    );
  });
  /** Whether any control differs from its default, including the scope ("Clear" shows). */
  const isActive = computed(() => isFiltered.value || filters.value.scope.kind !== "all");
  /** Loaded commits of the current walk; exact once the walk is done. */
  const matches = computed(() => repo.commits.length);

  /** The full names of the branches the pattern scope matches, in the refs' order. */
  const patternMatches = computed(() => {
    const scope = filters.value.scope;
    return scope.kind === "pattern" ? patternNames(scope.pattern, repo.refs, remotes.remotes) : [];
  });

  /**
   * The remote branches the scope names (short names): a pattern's matches, the branch chosen in
   * the sidebar. Their badges draw while the remote branches are hidden, so the rows they walk
   * keep their names.
   */
  const scopeRemotes = computed<string[]>(() => {
    const scope = filters.value.scope;
    const names =
      scope.kind === "pattern"
        ? patternMatches.value
        : scope.kind === "ref"
          ? [scope.fullName]
          : [];
    return names
      .filter((name) => name.startsWith("refs/remotes/"))
      .map((name) => name.slice("refs/remotes/".length));
  });

  function toWalkScope(scope: GraphScope): WalkScope {
    switch (scope.kind) {
      case "all":
        return hideRemotes.value ? { kind: "local" } : { kind: "all" };
      case "pattern":
        return {
          kind: "refs",
          names: patternNames(scope.pattern, repo.refs, remotes.remotes).slice(0, MAX_SCOPE_NAMES),
        };
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
    if (f.code) filter.content = { text: f.code.text, lines: f.code.lines };
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

  /** Hides or shows the remote branches; the walk restarts when its scope is all branches. */
  function setHideRemotes(hide: boolean): void {
    if (hide === hideRemotes.value) return;
    const before = scopeKey(walkScope.value);
    void settings.update("graphHideRemotes", hide);
    if (scopeKey(walkScope.value) !== before) apply();
  }

  /** HEAD's commit and its date: the refs listing's, else a loaded commit decorated HEAD. */
  function headCommit(): { hash: string; time: number | null } | null {
    const head = repo.refs.find((entry) => entry.kind === "head");
    if (head) return { hash: head.target, time: head.committedAt };
    const decorated = repo.commits.find((commit) => commit.refs.includes("HEAD"));
    return decorated ? { hash: decorated.hash, time: decorated.committer.time } : null;
  }

  /**
   * Selects HEAD's commit, asking for the walk's next pages until it arrives. HEAD is left out
   * ("outside") once the walk ends without it or lists commits a day older than it. The search
   * gives up ("none") when HEAD is unborn, the walk fails, the history lists again (another
   * repository, scope or filters, a move) or a later Go to HEAD starts.
   */
  async function goToHead(): Promise<HeadSearch> {
    const search = ++headSearch;
    const head = headCommit();
    if (!head) return "none";
    const listing = () =>
      JSON.stringify([repo.repo?.root, repo.historyVersion, walkScope.value, walkFilter.value]);
    const started = listing();
    for (;;) {
      if (search !== headSearch || listing() !== started) return "none";
      if (repo.state.kind !== "ready" || repo.walkError) return "none";
      const index = repo.commits.findIndex((commit) => commit.hash === head.hash);
      if (index >= 0) {
        repo.select(index);
        return "selected";
      }
      const last = repo.commits[repo.commits.length - 1];
      if (head.time !== null && last && last.committer.time < head.time - HEAD_SLACK_SECONDS) {
        return "outside";
      }
      if (repo.canLoadMore) repo.loadMore();
      else if (!repo.streaming) return "outside";
      await new Promise<void>((resolve) => {
        const stop = watch(
          () => [repo.commits.length, repo.streaming, listing()] as const,
          () => {
            stop();
            resolve();
          },
        );
      });
    }
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

  /**
   * The code search, the text as written, spaces included, without the control characters the
   * engine refuses (pasted with it) and past its longest; a blank text clears it.
   */
  function setCode(code: CodeSearch | null): void {
    const text = withoutControlCharacters(code?.text ?? "").slice(0, MAX_CODE_TEXT);
    const next = code && text.trim() !== "" ? { text, lines: code.lines } : null;
    const current = filters.value.code;
    if (current?.text === next?.text && current?.lines === next?.lines) return;
    filters.value = { ...filters.value, code: next };
    apply();
  }

  /** Every control back to its default, the scope included. */
  function clear(): void {
    if (!isActive.value) return;
    filters.value = defaultFilters();
    apply();
  }

  /**
   * A file's history: the graph filtered by `path` alone, the text, author, date and code
   * search cleared (left there, they would hide commits of the file unsaid) and the scope kept.
   * The path is git's own (a file's), taken as it is. A `root` other than the open repository's
   * is shown first, as its "Open repository" does, and starts from its own filters; when it
   * fails to open, the graph shows the error, unless another open came after it.
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
      current.path === next.path &&
      current.code === null;
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
        filters.value.scope.kind === "current" || filters.value.scope.kind === "pattern"
          ? scopeKey(walkScope.value)
          : null,
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
    hideRemotes,
    patternMatches,
    scopeRemotes,
    setHideRemotes,
    goToHead,
    diffBase,
    rangeEnd,
    setText,
    setScope,
    setAuthor,
    setDateRange,
    setPath,
    setCode,
    clear,
    showHistory,
    setDiffBase,
    setRangeEnd,
  };
});
