<script setup lang="ts">
// The top bar: the project switcher with Fetch, Pull and Push for the repository the graph
// shows (while one is open, outside the Overview), the palette trigger, and the gear, which
// shows the settings' tab. The views (the graph, review, the changes, the Overview) are tabs of
// the row below, not buttons here.

import { Search, Settings } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";
import Kbd from "@/components/Kbd.vue";
import { useShortcutHint } from "@/shortcuts/useShortcut";

import SyncButtons from "@/remotes/SyncButtons.vue";

import ProjectSwitcher from "./ProjectSwitcher.vue";

const props = defineProps<{
  /** Whether the settings' tab shows: the gear shows pressed. */
  settingsShown: boolean;
  /** Whether Fetch, Pull and Push show: a repository is open and the Overview does not show. */
  showSync: boolean;
}>();
const emit = defineEmits<{
  openFolder: [];
  openPalette: [];
  openSettings: [];
}>();

const { t } = useI18n();
const paletteHint = useShortcutHint("palette");
const settingsHint = useShortcutHint("settings");
</script>

<template>
  <header
    class="flex h-bar-top shrink-0 items-center gap-4 border-b border-line px-3"
    data-testid="top-bar"
  >
    <!-- Without min-w-0 the slot keeps room for what it holds: the palette trigger gives way
         first, and the switcher's name before the buttons. -->
    <div class="flex flex-1 items-center gap-3">
      <ProjectSwitcher class="switcher" @open-folder="emit('openFolder')" />
      <template v-if="props.showSync">
        <span class="h-4 w-px shrink-0 bg-line" aria-hidden="true" />
        <SyncButtons />
      </template>
    </div>
    <button
      type="button"
      class="palette-trigger flex h-control min-w-0 items-center gap-2 rounded-sm border border-line-strong px-3 text-md text-fg-muted hover:bg-hover"
      data-testid="palette-trigger"
      @click="emit('openPalette')"
    >
      <Search :size="16" :stroke-width="1.5" aria-hidden="true" class="text-fg-secondary" />
      <span class="flex-1 truncate text-left">{{ t("topBar.search") }}</span>
      <Kbd :keys="paletteHint" />
    </button>
    <div class="flex flex-1 items-center justify-end gap-2">
      <IconButton
        :label="t('topBar.settings')"
        :keys="settingsHint"
        :icon="Settings"
        :pressed="props.settingsShown"
        data-testid="mode-settings"
        @click="emit('openSettings')"
      />
    </div>
  </header>
</template>

<style scoped>
/* The palette trigger is 480px wide; that width is not on the spacing scale. A window
   short of room (a narrow one at a high zoom) shrinks it before the project's name, which keeps
   room for a few letters beside its icon and chevron (88px), and never overlaps the buttons after
   it. */
.palette-trigger {
  width: 480px;
  min-width: 140px;
}
.switcher {
  min-width: 88px;
}
</style>
