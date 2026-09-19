<script setup lang="ts">
// The 48px graph strip of review focus: one dot per commit around the selected one, which is
// pinned with the accent ring. Clicking a dot selects that commit; clicking the strip's
// background returns to graph focus.

import { computed } from "vue";
import { useI18n } from "vue-i18n";

import type { CommitNode } from "@/ipc/schemas";

const props = defineProps<{ commits: CommitNode[]; selectedIndex: number }>();
const emit = defineEmits<{ select: [index: number]; back: [] }>();

const { t } = useI18n();
const WINDOW = 14;

const window = computed(() => {
  const start = Math.max(0, props.selectedIndex - WINDOW);
  const end = Math.min(props.commits.length, props.selectedIndex + WINDOW + 1);
  return props.commits.slice(start, end).map((commit, i) => ({ commit, index: start + i }));
});

function laneClass(commit: CommitNode): string {
  const lanes = [
    "bg-lane-1",
    "bg-lane-2",
    "bg-lane-3",
    "bg-lane-4",
    "bg-lane-5",
    "bg-lane-6",
    "bg-lane-7",
    "bg-lane-8",
  ];
  return lanes[commit.lane % lanes.length] ?? "bg-lane-1";
}
</script>

<template>
  <div
    class="flex w-rail shrink-0 flex-col items-center overflow-hidden border-r border-line py-2"
    data-testid="graph-rail"
    :title="t('topBar.graphFocus')"
    @click.self="emit('back')"
  >
    <button
      v-for="entry in window"
      :key="entry.commit.hash"
      type="button"
      class="flex h-row-graph shrink-0 items-center justify-center"
      :aria-label="entry.commit.subject"
      :aria-current="entry.index === props.selectedIndex ? 'true' : undefined"
      @click="emit('select', entry.index)"
    >
      <span
        class="graph-rail-dot block rounded-full"
        :class="[
          laneClass(entry.commit),
          entry.index === props.selectedIndex
            ? 'ring-2 ring-accent ring-offset-2 ring-offset-app'
            : '',
        ]"
      ></span>
    </button>
  </div>
</template>

<style scoped>
.graph-rail-dot {
  width: 8px;
  height: 8px;
}
</style>
