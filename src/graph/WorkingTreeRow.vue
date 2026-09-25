<script setup lang="ts">
// The working tree's row above the graph: while the working
// tree or the index holds changes, "Uncommitted changes" with the counts of the changes screen's
// lists, opening that screen on a click or ↵; when the lists could not be read, the failure,
// which the screen explains. It sits outside the commit list: no lane of its own, no selection,
// j and k stay on the commits.

import { CircleDashed } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { headTarget, useRepoStore } from "@/stores/repo";
import { useChangesStore } from "@/stores/changes";

import { DRAWN_LANES, laneX } from "./useGraphGeometry";

const emit = defineEmits<{
  open: [];
  /** The row went away while it held the focus: the list takes it. */
  leave: [];
}>();

const { t, n } = useI18n();
const changes = useChangesStore();
const repo = useRepoStore();
const button = ref<HTMLButtonElement | null>(null);

const counts = computed(() => changes.counts);
const failed = computed(() => changes.loaded && changes.error !== null);
const shown = computed(
  () => failed.value || (counts.value !== null && counts.value.unstaged + counts.value.staged > 0),
);

/* The circle sits on HEAD's lane, where the commit the changes will follow is drawn; lane 0 when
   HEAD is not listed or the walk is flat. The row's 2px border, like a commit row's, and half
   the 14px icon come off the lane's x. */
const ICON = 14;
const iconLeft = computed(() => {
  const head = headTarget(repo.refs);
  const commit =
    repo.walkFilter === undefined && head !== null
      ? repo.commits.find((candidate) => candidate.hash === head)
      : undefined;
  const lane = Math.min(commit?.lane ?? 0, DRAWN_LANES - 1);
  return `${laneX(lane) - 2 - ICON / 2}px`;
});

watch(shown, (now) => {
  if (!now && button.value !== null && document.activeElement === button.value) emit("leave");
});
</script>

<template>
  <button
    v-if="shown"
    ref="button"
    type="button"
    class="relative flex h-row-graph w-full shrink-0 items-center overflow-hidden border-b border-l-2 border-line border-l-transparent pr-3 text-left text-md whitespace-nowrap hover:bg-hover"
    data-testid="working-tree-row"
    @click="emit('open')"
  >
    <CircleDashed
      class="absolute"
      :class="failed ? 'text-danger' : 'text-fg-muted'"
      :style="{ left: iconLeft }"
      :size="ICON"
      :stroke-width="1.5"
      aria-hidden="true"
    />
    <span class="graph-lane-area block shrink-0" aria-hidden="true" />
    <span v-if="failed" class="min-w-0 truncate text-danger" data-testid="working-tree-failed">
      {{ t("statusBar.changesFailed") }}
    </span>
    <template v-else-if="counts">
      <span class="min-w-0 truncate text-fg">{{ t("graph.workingTree.label") }}</span>
      <span
        class="ml-4 flex shrink-0 gap-4 text-sm text-fg-muted"
        data-testid="working-tree-counts"
      >
        <span v-if="counts.unstaged > 0">
          {{ t("graph.workingTree.unstaged", { n: n(counts.unstaged) }, counts.unstaged) }}
        </span>
        <span v-if="counts.staged > 0">
          {{ t("graph.workingTree.staged", { n: n(counts.staged) }, counts.staged) }}
        </span>
      </span>
    </template>
  </button>
</template>

<style scoped>
/* The lane area of a commit row (CommitRows), so the label starts where the subjects do. */
.graph-lane-area {
  width: 114px;
}
</style>
