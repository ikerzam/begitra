<script setup lang="ts">
// Graph focus, beside the shell's sidebar: the graph panel and the detail panel; with no repository
// shown, the open project's empty state, or Home with no project open (the empty one until a
// project exists).

import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import DetailPanel from "@/detail/DetailPanel.vue";
import HomeScreen from "@/discovery/HomeScreen.vue";
import GraphPanel from "@/graph/GraphPanel.vue";
import type { FileChange } from "@/ipc/schemas";
import ProjectEmpty from "@/project/ProjectEmpty.vue";
import { useProjectsStore } from "@/stores/projects";
import { useRepoStore } from "@/stores/repo";
import { useShellStore } from "@/stores/shell";

import HomeEmpty from "./HomeEmpty.vue";
import PaneResizer from "./PaneResizer.vue";

const emit = defineEmits<{
  openFolder: [];
  addFolder: [];
  review: [file?: FileChange];
  removeFromProject: [];
}>();

const { t } = useI18n();
const shell = useShellStore();
const repo = useRepoStore();
const projects = useProjectsStore();
const graph = ref<{ focus(): void } | null>(null);

const detailWidth = computed(() => `${shell.detailWidth}px`);
/**
 * The empty Home once the projects have loaded with none; until then Home shows its loading rows
 * rather than a false empty state.
 */
const homeIsEmpty = computed(
  () => projects.loaded && projects.loadError === null && projects.projects.length === 0,
);

defineExpose({ focusRows: () => graph.value?.focus() });
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1" data-testid="graph-focus">
    <template v-if="repo.state.kind === 'empty'">
      <ProjectEmpty v-if="projects.active" />
      <HomeEmpty
        v-else-if="homeIsEmpty"
        @open-folder="emit('openFolder')"
        @add-folder="emit('addFolder')"
      />
      <HomeScreen v-else @open-folder="emit('openFolder')" />
    </template>
    <template v-else>
      <GraphPanel
        ref="graph"
        @activate="emit('review')"
        @remove-from-project="emit('removeFromProject')"
      />
      <PaneResizer
        :size="shell.detailWidth"
        :direction="-1"
        :min="shell.detailLimits.min"
        :max="shell.detailLimits.max"
        :label="t('detail.commit')"
        @resize="(px) => void shell.setPaneSize('detail', px)"
        @reset="() => void shell.resetPaneSize('detail')"
      />
      <DetailPanel
        class="shrink-0"
        :style="{ width: detailWidth }"
        @review="(file) => emit('review', file)"
      />
    </template>
  </div>
</template>
