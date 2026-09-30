<script setup lang="ts">
// The 48px graph strip of review focus: the lanes of the commits around the selected one,
// drawn with the same geometry as the graph panel on a narrower layout, the selected commit
// pinned with the 14px accent ring. Clicking a row selects that commit, whose subject is its
// tooltip; clicking the strip's background returns to graph focus.

import { computed } from "vue";

import GraphCanvas from "@/graph/GraphCanvas.vue";
import { laneX, ROW_HEIGHT, type LaneLayout } from "@/graph/useGraphGeometry";
import type { CommitNode } from "@/ipc/schemas";

const props = defineProps<{ commits: CommitNode[]; selectedIndex: number; flat?: boolean }>();
const emit = defineEmits<{ select: [index: number]; back: [] }>();

const WINDOW = 14;
/** Three 12px lanes from x = 10 inside the 48px rail. */
const RAIL_LAYOUT: LaneLayout = { laneWidth: 12, offset: 10, drawn: 3 };
const RAIL_WIDTH = 48;

/**
 * The rows around the selected one. The canvas gets the whole list with the window as its
 * range, so the lines that enter the first row and leave the last one are drawn to the edges.
 */
const window = computed(() => {
  const start = Math.max(0, props.selectedIndex - WINDOW);
  const end = Math.min(props.commits.length, props.selectedIndex + WINDOW + 1);
  return { start, end, commits: props.commits.slice(start, end) };
});

const height = computed(() => window.value.commits.length * ROW_HEIGHT);

/** Where the ring sits: over the selected commit's dot, on the last drawn lane past it. */
const ring = computed(() => {
  const commit = props.commits[props.selectedIndex];
  if (!commit) return null;
  const lane = Math.min(commit.lane, RAIL_LAYOUT.drawn - 1);
  const row = props.selectedIndex - window.value.start;
  return { left: laneX(lane, RAIL_LAYOUT), top: row * ROW_HEIGHT + ROW_HEIGHT / 2 };
});
</script>

<template>
  <div
    class="relative flex w-rail shrink-0 flex-col overflow-hidden border-r border-line"
    data-testid="graph-rail"
    @click.self="emit('back')"
  >
    <!-- Out of the flow, so each row's button lies over its dot: the canvas itself is sticky,
         as the graph panel's scrolling needs, and would push the buttons under the drawing. -->
    <div class="pointer-events-none absolute top-0 left-0" aria-hidden="true">
      <GraphCanvas
        :commits="props.commits"
        :start="window.start"
        :end="window.end"
        :scroll-top="window.start * ROW_HEIGHT"
        :height="height"
        :width="RAIL_WIDTH"
        :layout="RAIL_LAYOUT"
        :flat="props.flat"
      />
    </div>
    <button
      v-for="(commit, offset) in window.commits"
      :key="commit.hash"
      type="button"
      class="h-row-graph w-full shrink-0"
      :aria-label="commit.subject"
      :data-tooltip="commit.subject"
      :aria-current="window.start + offset === props.selectedIndex ? 'true' : undefined"
      @click="emit('select', window.start + offset)"
    />
    <span
      v-if="ring"
      aria-hidden="true"
      class="graph-rail-ring pointer-events-none absolute z-10 rounded-full border-2 border-accent"
      :style="{ left: `${ring.left}px`, top: `${ring.top}px` }"
    />
  </div>
</template>

<style scoped>
/* The 14px accent ring of the rail, centred on the 8px dot. */
.graph-rail-ring {
  width: 14px;
  height: 14px;
  transform: translate(-50%, -50%);
}
</style>
