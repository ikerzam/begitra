<script setup lang="ts">
import { FileDiff, FilePen, GitGraph, Search, Settings } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";
import Kbd from "@/components/Kbd.vue";
import Tooltip from "@/components/Tooltip.vue";
import { useShortcutHint } from "@/shortcuts/useShortcut";
import type { LayoutMode } from "@/stores/settings";

import RepoSwitcher from "./RepoSwitcher.vue";

const props = defineProps<{
  /** Name of the open repository, or null when none is open. */
  repositoryName: string | null;
  /** Root of the open repository, marked in the switcher menu. */
  repositoryRoot: string | null;
  layoutMode: LayoutMode;
  /** Files with a change in the working tree or the index: the Changes toggle's count. */
  changedCount: number;
  /** Whether a repository is ready, which the changes screen needs. */
  canShowChanges: boolean;
}>();
const emit = defineEmits<{ openFolder: []; openPalette: []; setLayoutMode: [mode: LayoutMode] }>();

const { t } = useI18n();
const paletteHint = useShortcutHint("palette");
const settingsHint = useShortcutHint("settings");
const graphHint = useShortcutHint("graph-focus");
const reviewHint = useShortcutHint("review-focus");
const changesHint = useShortcutHint("changes-focus");
</script>

<template>
  <header
    class="flex h-bar-top shrink-0 items-center gap-4 border-b border-line px-3"
    data-testid="top-bar"
  >
    <div class="flex min-w-0 flex-1 items-center">
      <RepoSwitcher
        :repository-name="props.repositoryName"
        :repository-root="props.repositoryRoot"
        @open-folder="emit('openFolder')"
      />
    </div>
    <button
      type="button"
      class="palette-trigger flex h-control shrink-0 items-center gap-2 rounded-sm border border-line-strong px-3 text-md text-fg-muted hover:bg-hover"
      data-testid="palette-trigger"
      @click="emit('openPalette')"
    >
      <Search :size="16" :stroke-width="1.5" aria-hidden="true" class="text-fg-secondary" />
      <span class="flex-1 truncate text-left">{{ t("topBar.search") }}</span>
      <Kbd :keys="paletteHint" />
    </button>
    <!-- Tooltips carry the shortcut hint; the buttons drop their native title to avoid two. -->
    <div class="flex flex-1 items-center justify-end gap-2">
      <Tooltip
        v-slot="{ id }"
        :label="t('topBar.settings')"
        :keys="settingsHint"
        data-testid="tooltip-settings"
      >
        <IconButton
          :label="t('topBar.settings')"
          :icon="Settings"
          :pressed="props.layoutMode === 'settings'"
          :native-title="false"
          :aria-describedby="id"
          data-testid="mode-settings"
          @click="emit('setLayoutMode', 'settings')"
        />
      </Tooltip>
      <Tooltip
        v-slot="{ id }"
        :label="t('topBar.graphFocus')"
        :keys="graphHint"
        data-testid="tooltip-graph"
      >
        <IconButton
          :label="t('topBar.graphFocus')"
          :icon="GitGraph"
          :pressed="props.layoutMode === 'graph'"
          :native-title="false"
          :aria-describedby="id"
          data-testid="mode-graph"
          @click="emit('setLayoutMode', 'graph')"
        />
      </Tooltip>
      <Tooltip
        v-slot="{ id }"
        :label="t('topBar.reviewFocus')"
        :keys="reviewHint"
        data-testid="tooltip-review"
      >
        <IconButton
          :label="t('topBar.reviewFocus')"
          :icon="FileDiff"
          :pressed="props.layoutMode === 'review'"
          :native-title="false"
          :aria-describedby="id"
          data-testid="mode-review"
          @click="emit('setLayoutMode', 'review')"
        />
      </Tooltip>
      <Tooltip
        v-slot="{ id }"
        :label="t('topBar.changes')"
        :keys="changesHint"
        data-testid="tooltip-changes"
      >
        <IconButton
          :label="
            props.changedCount > 0
              ? t('topBar.changesCount', { n: props.changedCount }, props.changedCount)
              : t('topBar.changes')
          "
          :icon="FilePen"
          :count="props.changedCount"
          :pressed="props.layoutMode === 'changes'"
          :disabled="!props.canShowChanges"
          :native-title="false"
          :aria-describedby="id"
          data-testid="mode-changes"
          @click="emit('setLayoutMode', 'changes')"
        />
      </Tooltip>
    </div>
  </header>
</template>

<style scoped>
/* The palette trigger is 480px wide; that width is not on the spacing scale. */
.palette-trigger {
  width: 480px;
}
</style>
