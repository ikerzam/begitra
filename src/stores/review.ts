// Review focus state: the file filters, the open file, the files marked reviewed (in memory
// only), the files the user chose to show despite being large,
// generated or binary, and the two commits the graph pins: the diff base
// ("Diff from here") and the range end ("Select as range end").

import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { isLockfile, type FileFilters } from "@/detail/groupFiles";
import type { FileChange } from "@/ipc/schemas";

export const useReviewStore = defineStore("review", () => {
  const filters = ref<FileFilters>({ hideGenerated: true, hideLockfiles: true, hideTests: false });
  const selectedPath = ref<string | null>(null);
  const reviewed = ref(new Set<string>());
  const revealed = ref(new Set<string>());
  /** Hash of the commit the reviewed and revealed sets belong to. */
  const commitHash = ref<string | null>(null);
  /** Commit chosen with "Diff from here", for the review's diff modes. */
  const diffBase = ref<string | null>(null);
  /** Commit chosen with "Select as range end", for the comparison. */
  const rangeEnd = ref<string | null>(null);

  const reviewedCount = computed(() => reviewed.value.size);

  function setFilter<K extends keyof FileFilters>(key: K, value: boolean): void {
    filters.value = { ...filters.value, [key]: value };
  }

  function select(path: string | null): void {
    selectedPath.value = path;
  }

  /** Forgets per-commit state when another commit is reviewed. */
  function forCommit(hash: string | null): void {
    if (commitHash.value === hash) return;
    commitHash.value = hash;
    selectedPath.value = null;
    reviewed.value = new Set();
    revealed.value = new Set();
  }

  /** Opens `hash` for review, on `file` when given, lifting the filter that would hide it. */
  function open(hash: string, file: FileChange | null): void {
    forCommit(hash);
    if (!file) return;
    if (isLockfile(file.path)) {
      if (filters.value.hideLockfiles) setFilter("hideLockfiles", false);
    } else if (file.isGenerated && filters.value.hideGenerated) {
      setFilter("hideGenerated", false);
    }
    if (file.isTest && filters.value.hideTests) setFilter("hideTests", false);
    selectedPath.value = file.path;
  }

  function toggleReviewed(path: string): void {
    const next = new Set(reviewed.value);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    reviewed.value = next;
  }

  function reveal(path: string): void {
    revealed.value = new Set(revealed.value).add(path);
  }

  function setDiffBase(hash: string | null): void {
    diffBase.value = hash;
  }

  function setRangeEnd(hash: string | null): void {
    rangeEnd.value = hash;
  }

  /** Forgets both pinned commits (another repository opened). */
  function clearPins(): void {
    diffBase.value = null;
    rangeEnd.value = null;
  }

  return {
    filters,
    selectedPath,
    reviewed,
    revealed,
    commitHash,
    reviewedCount,
    setFilter,
    select,
    forCommit,
    open,
    toggleReviewed,
    reveal,
    diffBase,
    rangeEnd,
    setDiffBase,
    setRangeEnd,
    clearPins,
  };
});
