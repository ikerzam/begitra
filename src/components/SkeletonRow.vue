<script setup lang="ts">
import { computed } from "vue";

import type { SkeletonHeight } from "./types";

const props = withDefaults(
  defineProps<{
    /** Position in the list; picks one of four width patterns so rows never look like a grid. */
    index?: number;
    height?: SkeletonHeight;
  }>(),
  { index: 0, height: "graph" },
);

const heightClasses: Record<SkeletonHeight, string> = {
  graph: "h-row-graph",
  list: "h-row-list",
  tree: "h-row-tree",
  diff: "h-row-diff",
};

/* Line widths: one long line (220, 180,
   240 or 200px), then 56 and 44px, capped by the row. */
const patterns = [
  ["220px", "56px", "44px"],
  ["180px", "56px", "44px"],
  ["240px", "56px", "44px"],
  ["200px", "56px", "44px"],
] as const;

const widths = computed(() => patterns[Math.abs(props.index) % patterns.length] ?? patterns[0]);
</script>

<template>
  <div
    aria-hidden="true"
    data-testid="skeleton-row"
    class="flex items-center gap-3 px-3"
    :class="heightClasses[props.height]"
  >
    <span class="size-2 shrink-0 rounded-full bg-selected" />
    <span
      v-for="(width, i) in widths"
      :key="i"
      class="skeleton-line max-w-full rounded-full bg-hover"
      :style="{ width }"
    />
  </div>
</template>

<style scoped>
/* Skeleton lines are 10px tall; no spacing step is 10. */
.skeleton-line {
  height: 10px;
}
</style>
