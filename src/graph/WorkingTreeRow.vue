<script setup lang="ts">
// The working tree's row above the graph: while the working
// tree or the index holds changes, "Uncommitted changes" with the counts of the changes screen's
// lists, opening that screen on a click or ↵. It sits outside the commit list: no lane, no
// selection, j and k stay on the commits.

import { CircleDashed } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import { useChangesStore } from "@/stores/changes";

import { laneX } from "./useGraphGeometry";

const emit = defineEmits<{ open: [] }>();

const { t } = useI18n();
const changes = useChangesStore();

const shown = computed(() => changes.unstagedCount + changes.stagedCount > 0);
const counts = computed(() =>
  [
    changes.unstagedCount > 0
      ? t("graph.workingTree.unstaged", { n: changes.unstagedCount }, changes.unstagedCount)
      : null,
    changes.stagedCount > 0
      ? t("graph.workingTree.staged", { n: changes.stagedCount }, changes.stagedCount)
      : null,
  ]
    .filter((part) => part !== null)
    .join(" · "),
);

/* The dashed circle sits where the canvas centres lane 0's dots: the row's 2px border, like a
   commit row's, and half the 14px icon come off the lane's x. */
const ICON = 14;
const iconLeft = `${laneX(0) - 2 - ICON / 2}px`;
</script>

<template>
  <button
    v-if="shown"
    type="button"
    class="relative flex h-row-graph w-full shrink-0 items-center border-b border-l-2 border-line border-l-transparent pr-3 text-left text-md whitespace-nowrap hover:bg-hover"
    data-testid="working-tree-row"
    @click="emit('open')"
  >
    <CircleDashed
      class="absolute text-fg-muted"
      :style="{ left: iconLeft }"
      :size="ICON"
      :stroke-width="1.5"
      aria-hidden="true"
    />
    <span class="graph-lane-area block shrink-0" aria-hidden="true" />
    <span class="truncate text-fg">{{ t("graph.workingTree.label") }}</span>
    <span class="ml-3 shrink-0 text-sm text-fg-muted" data-testid="working-tree-counts">
      {{ counts }}
    </span>
  </button>
</template>

<style scoped>
/* The lane area of a commit row (CommitRows), so the label starts where the subjects do. */
.graph-lane-area {
  width: 114px;
}
</style>
