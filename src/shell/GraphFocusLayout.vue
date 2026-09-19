<script setup lang="ts">
// Graph focus: sidebar (or rail), the graph panel and the detail panel; the empty shell when
// no repository is open.

import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import DetailPanel from "@/detail/DetailPanel.vue";
import GraphPanel from "@/graph/GraphPanel.vue";
import type { FileChange } from "@/ipc/schemas";
import { useRepoStore } from "@/stores/repo";
import { paneLimits, useShellStore } from "@/stores/shell";

import HomeEmpty from "./HomeEmpty.vue";
import PaneResizer from "./PaneResizer.vue";
import Sidebar from "./Sidebar.vue";
import SidebarRail from "./SidebarRail.vue";

const emit = defineEmits<{ openFolder: []; review: [file?: FileChange]; removeFromList: [] }>();

const { t } = useI18n();
const shell = useShellStore();
const repo = useRepoStore();
const graph = ref<{ focus(): void } | null>(null);

const showSidebar = computed(() => repo.state.kind !== "empty" && !shell.sidebarCollapsed);
const detailWidth = computed(() => `${shell.detailWidth}px`);

defineExpose({ focusRows: () => graph.value?.focus() });
</script>

<template>
  <div class="flex min-h-0 flex-1" data-testid="graph-focus">
    <Sidebar v-if="showSidebar" />
    <SidebarRail
      v-else
      :active="shell.sidebarTab"
      @select="(tab) => void shell.expandSidebar(tab)"
    />
    <HomeEmpty v-if="repo.state.kind === 'empty'" @open-folder="emit('openFolder')" />
    <template v-else>
      <GraphPanel
        ref="graph"
        @activate="emit('review')"
        @remove-from-list="emit('removeFromList')"
      />
      <PaneResizer
        :size="shell.detailWidth"
        :direction="-1"
        :min="paneLimits.detail.min"
        :max="paneLimits.detail.max"
        :label="t('detail.commit')"
        @resize="(px) => void shell.setPaneSize('detail', px)"
      />
      <DetailPanel
        class="shrink-0"
        :style="{ width: detailWidth }"
        @review="(file) => emit('review', file)"
      />
    </template>
  </div>
</template>
