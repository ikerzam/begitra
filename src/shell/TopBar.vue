<script setup lang="ts">
import { ChevronDown, FileDiff, FolderGit2, GitGraph, Search, Settings } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";
import Kbd from "@/components/Kbd.vue";
import { useShortcutHint } from "@/shortcuts/useShortcut";
import type { LayoutMode } from "@/stores/settings";

const props = defineProps<{
  /** Name of the open repository, or null when none is open. */
  repositoryName: string | null;
  layoutMode: LayoutMode;
}>();
const emit = defineEmits<{ openFolder: []; openPalette: []; setLayoutMode: [mode: LayoutMode] }>();

const { t } = useI18n();
const paletteHint = useShortcutHint("palette");
const name = computed(() => props.repositoryName ?? t("topBar.noRepository"));
</script>

<template>
  <header
    class="flex h-bar-top shrink-0 items-center gap-4 border-b border-line px-3"
    data-testid="top-bar"
  >
    <div class="flex flex-1 items-center">
      <button
        type="button"
        class="flex h-control items-center gap-2 rounded-md px-2 text-md font-medium text-fg hover:bg-hover"
        :title="t('topBar.switchRepository')"
        data-testid="repo-switcher"
        @click="emit('openFolder')"
      >
        <FolderGit2 :size="16" :stroke-width="1.5" aria-hidden="true" class="text-fg-secondary" />
        <span class="truncate">{{ name }}</span>
        <ChevronDown :size="16" :stroke-width="1.5" aria-hidden="true" class="text-fg-secondary" />
      </button>
    </div>
    <button
      type="button"
      class="palette-trigger flex h-control shrink-0 items-center gap-2 rounded-md border border-line px-3 text-md text-fg-muted hover:bg-hover"
      data-testid="palette-trigger"
      @click="emit('openPalette')"
    >
      <Search :size="16" :stroke-width="1.5" aria-hidden="true" class="text-fg-secondary" />
      <span class="flex-1 truncate text-left">{{ t("topBar.search") }}</span>
      <Kbd :keys="paletteHint" />
    </button>
    <div class="flex flex-1 items-center justify-end gap-1">
      <IconButton :label="t('topBar.settings')" :icon="Settings" disabled />
      <IconButton
        :label="t('topBar.graphFocus')"
        :icon="GitGraph"
        :pressed="props.layoutMode === 'graph'"
        data-testid="mode-graph"
        @click="emit('setLayoutMode', 'graph')"
      />
      <IconButton
        :label="t('topBar.reviewFocus')"
        :icon="FileDiff"
        :pressed="props.layoutMode === 'review'"
        data-testid="mode-review"
        @click="emit('setLayoutMode', 'review')"
      />
    </div>
  </header>
</template>

<style scoped>
/* The palette trigger is 480px wide; that width is not on the spacing scale. */
.palette-trigger {
  width: 480px;
}
</style>
