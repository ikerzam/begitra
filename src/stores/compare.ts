// The comparison of two endpoints: the merge base with the counts of commits only
// on each side, the merge preview, the two side lists streamed as range walks, and the file
// summary, which is the review's comparison target `a...b` on its panel and viewer. The endpoints
// are the tab's shown (`tabs.ts`): each comparison has its tab, remembered with the project, and
// showing it recomputes the comparison.

import { defineStore } from "pinia";
import { computed, ref, shallowRef, watch } from "vue";

import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type { CommitNode, Comparison, MergePreview, RepoChangeKind, WalkPage } from "@/ipc/schemas";
import type { StreamHandle } from "@/ipc/stream";

import { useOperationsStore } from "./operations";
import { useRepoStore } from "./repo";
import { useReviewStore } from "./review";
import type { CompareEndpoint, CompareEndpoints } from "./settings";
import { useShellStore } from "./shell";
import { useTabsStore } from "./tabs";

export type CompareSide = "a" | "b";

/** The commits only on one side, streamed in pages of 500. */
export interface SideList {
  commits: CommitNode[];
  loading: boolean;
  error: AppError | null;
  /** The walk to continue, once its first page arrived. */
  walkId: string | null;
  nextIndex: number;
  done: boolean;
}

function emptySide(): SideList {
  return { commits: [], loading: false, error: null, walkId: null, nextIndex: 0, done: false };
}

/** Pages one request of a side list asks for. */
const PAGES_PER_REQUEST = 1;

export const useCompareStore = defineStore("compare", () => {
  const repo = useRepoStore();
  const review = useReviewStore();
  const shell = useShellStore();
  const tabs = useTabsStore();
  const operations = useOperationsStore();

  const comparison = shallowRef<Comparison | null>(null);
  const comparisonError = ref<AppError | null>(null);
  const comparing = ref(false);
  const preview = shallowRef<MergePreview | null>(null);
  const previewError = ref<AppError | null>(null);
  const previewing = ref(false);
  const sides = ref<Record<CompareSide, SideList>>({ a: emptySide(), b: emptySide() });

  let serial = 0;
  let previewOpId: string | null = null;
  const handles: Record<CompareSide, StreamHandle | null> = { a: null, b: null };

  const endpoints = computed<CompareEndpoints | null>(() => tabs.activePair);
  /** Both endpoints name the same commit: nothing to compare. */
  const same = computed(() => comparison.value?.relation === "same");
  /** The paths the preview reports as conflicting. */
  const conflicts = computed(() => new Set(preview.value?.conflicts ?? []));
  const active = computed(() => endpoints.value !== null);
  /** A comparison's tab whose repository is still opening: the comparison waits for it. */
  const waiting = computed(() => active.value && repo.state.kind === "opening");

  function stopAll(): void {
    serial += 1;
    for (const side of ["a", "b"] as const) {
      void handles[side]?.cancel();
      handles[side] = null;
    }
    if (previewOpId) {
      void ipc.cancelOperation(previewOpId).catch(() => undefined);
      previewOpId = null;
    }
  }

  function reset(): void {
    comparison.value = null;
    comparisonError.value = null;
    comparing.value = false;
    preview.value = null;
    previewError.value = null;
    previewing.value = false;
    sides.value = { a: emptySide(), b: emptySide() };
  }

  /** The review target of the file summary: what `b` brings since the merge base. */
  function targetOf(pair: CompareEndpoints) {
    return { kind: "range" as const, from: pair.a.rev, to: pair.b.rev, threeDot: true };
  }

  /** Computes everything for the stored endpoints; earlier work is cancelled. */
  function load(): void {
    stopAll();
    reset();
    const pair = endpoints.value;
    const root = repo.repo?.root;
    if (!pair || !root || repo.state.kind !== "ready") return;
    const mine = serial;
    const current = () => mine === serial;
    review.setComparisonTarget(targetOf(pair));
    comparing.value = true;
    const opId = newOpId("compare");
    operations.start(opId, "operations.comparing");
    void (async () => {
      try {
        const result = await ipc.compare(root, pair.a.rev, pair.b.rev, opId);
        if (!current()) return;
        comparison.value = result;
        if (result.relation !== "same") {
          startPreview(root, pair, mine);
          startSide("a", root, result.a.hash, result.b.hash, mine);
          startSide("b", root, result.b.hash, result.a.hash, mine);
        }
      } catch (error) {
        if (current()) comparisonError.value = toAppError(error);
      } finally {
        if (current()) comparing.value = false;
        operations.finish(opId);
      }
    })();
  }

  function startPreview(root: string, pair: CompareEndpoints, mine: number): void {
    previewing.value = true;
    const opId = newOpId("preview");
    previewOpId = opId;
    void (async () => {
      try {
        const result = await ipc.mergePreview(root, pair.a.rev, pair.b.rev, opId);
        if (mine === serial) preview.value = result;
      } catch (error) {
        if (mine === serial) previewError.value = toAppError(error);
      } finally {
        if (mine === serial) previewing.value = false;
        if (previewOpId === opId) previewOpId = null;
      }
    })();
  }

  /** Streams the commits of `include` not reachable from `exclude`, newest first. */
  function startSide(
    side: CompareSide,
    root: string,
    include: string,
    exclude: string,
    mine: number,
  ) {
    sides.value = { ...sides.value, [side]: { ...emptySide(), loading: true } };
    const handle = ipc.walkCommits(
      root,
      { kind: "range", exclude, include },
      (page) => receive(side, page, mine),
      ipc.defaultWalkOptions,
      PAGES_PER_REQUEST,
      newOpId("side"),
    );
    handles[side] = handle;
    void settle(side, handle, mine);
  }

  function receive(side: CompareSide, page: WalkPage, mine: number): void {
    if (mine !== serial) return;
    const list = sides.value[side];
    sides.value = {
      ...sides.value,
      [side]: {
        ...list,
        commits: list.commits.concat(page.commits),
        walkId: page.walkId,
        nextIndex: page.index + 1,
        done: page.done,
      },
    };
  }

  async function settle(side: CompareSide, handle: StreamHandle, mine: number): Promise<void> {
    try {
      await handle.done;
    } catch (error) {
      if (mine !== serial) return;
      const failed = toAppError(error);
      if (failed.code !== "op.cancelled") {
        sides.value = {
          ...sides.value,
          [side]: { ...sides.value[side], error: failed, done: true },
        };
      }
    } finally {
      if (mine === serial && handles[side] === handle) {
        handles[side] = null;
        sides.value = { ...sides.value, [side]: { ...sides.value[side], loading: false } };
      }
    }
  }

  /** Asks for the next page of a side list. */
  function loadMore(side: CompareSide): void {
    const list = sides.value[side];
    if (list.loading || list.done || !list.walkId) return;
    const mine = serial;
    sides.value = { ...sides.value, [side]: { ...list, loading: true } };
    const handle = ipc.walkContinue(
      list.walkId,
      list.nextIndex,
      (page) => receive(side, page, mine),
      PAGES_PER_REQUEST,
      newOpId("side"),
    );
    handles[side] = handle;
    void settle(side, handle, mine);
  }

  /** Shows the comparison of `a` with `b`: its tab when one is open, else a new one. */
  function open(a: CompareEndpoint, b: CompareEndpoint): void {
    tabs.openComparison(a, b);
  }

  /** Replaces one endpoint of the comparison shown, in its tab. */
  function setEndpoint(side: CompareSide, endpoint: CompareEndpoint): void {
    const pair = endpoints.value;
    if (!pair) return;
    tabs.setPair(side === "a" ? endpoint : pair.a, side === "b" ? endpoint : pair.b);
  }

  /** Exchanges the endpoints: the counts trade places and the file summary flips. */
  function swap(): void {
    const pair = endpoints.value;
    if (pair) tabs.setPair(pair.b, pair.a);
  }

  function reload(): void {
    load();
  }

  /** Review focus on the same target, in the project's tab: the marks and notes carry over,
   * and the comparison's tab stays. */
  async function openInReview(): Promise<void> {
    const pair = endpoints.value;
    if (!pair) return;
    const shown = shell.setLayoutMode("review");
    review.setTarget(targetOf(pair));
    await shown;
  }

  /** A side-list commit chosen with Enter: the graph selects it when it lists it, and review
   * focus opens on it in the project's tab. */
  async function openCommit(hash: string): Promise<void> {
    selectCommit(hash);
    const shown = shell.setLayoutMode("review");
    review.setTarget({ kind: "commit", hash });
    await shown;
  }

  /** Selects the commit in the graph when the loaded history lists it. */
  function selectCommit(hash: string): boolean {
    const index = repo.commits.findIndex((commit) => commit.hash === hash);
    if (index >= 0) repo.select(index);
    return index >= 0;
  }

  /** Refs moved: the endpoints may point elsewhere now. */
  function onRepoChanged(kinds: RepoChangeKind[]): void {
    if (active.value && kinds.includes("refs")) load();
  }

  // Showing a comparison's tab (a restart on it, a click, Ctrl Tab), or changing an endpoint in
  // it, recomputes; the project's tab stops the streams and gives the review its own target back.
  watch(
    () => [active.value, repo.state.kind, endpoints.value] as const,
    ([on, state]) => {
      if (on && state === "ready") load();
      else {
        stopAll();
        if (!on) review.setComparisonTarget(null);
      }
    },
    { immediate: true },
  );

  // Another repository: the comparison goes.
  watch(
    () => repo.repo?.root,
    () => {
      stopAll();
      reset();
    },
  );

  return {
    endpoints,
    comparison,
    comparisonError,
    comparing,
    preview,
    previewError,
    previewing,
    sides,
    same,
    conflicts,
    active,
    waiting,
    open,
    setEndpoint,
    swap,
    reload,
    loadMore,
    openInReview,
    openCommit,
    selectCommit,
    onRepoChanged,
  };
});
