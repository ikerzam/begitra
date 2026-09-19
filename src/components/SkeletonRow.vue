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
};

/* Proportions: one long line, then two short ones. */
const patterns = [
  ["44%", "11%", "9%"],
  ["32%", "11%", "9%"],
  ["52%", "11%", "9%"],
  ["38%", "11%", "9%"],
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
      class="h-3 rounded-full bg-hover"
      :style="{ width }"
    />
  </div>
</template>
