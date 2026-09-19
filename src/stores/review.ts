// Review focus state: the file filters, the open file, the files marked reviewed
// (in memory only), and the files the user chose to
// show despite being large, generated or binary.

import { defineStore } from "pinia";
import { computed, ref } from "vue";

import type { FileFilters } from "@/detail/groupFiles";

export const useReviewStore = defineStore("review", () => {
  const filters = ref<FileFilters>({ hideGenerated: true, hideLockfiles: true, hideTests: false });
  const selectedPath = ref<string | null>(null);
  const reviewed = ref(new Set<string>());
  const revealed = ref(new Set<string>());
  /** Hash of the commit the reviewed and revealed sets belong to. */
  const commitHash = ref<string | null>(null);

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

  function toggleReviewed(path: string): void {
    const next = new Set(reviewed.value);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    reviewed.value = next;
  }

  function reveal(path: string): void {
    revealed.value = new Set(revealed.value).add(path);
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
    toggleReviewed,
    reveal,
  };
});
