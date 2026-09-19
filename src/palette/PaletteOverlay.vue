<script setup lang="ts">
import {
  Code,
  FileDiff,
  FolderGit2,
  GitGraph,
  Languages,
  PanelLeft,
  Search,
  Terminal,
  X,
} from "@lucide/vue";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Kbd from "@/components/Kbd.vue";
import { setLocale } from "@/i18n";
import { useExternal } from "@/shell/useExternal";
import { useOpenFolder } from "@/shell/useOpenFolder";
import { shortcutRegistry } from "@/shortcuts/registry";
import { useRepoStore } from "@/stores/repo";
import { useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";

import { paletteCommands, type PaletteActions } from "./commands";
import { usePalette, type PaletteRow } from "./usePalette";

const { t } = useI18n();
const shell = useShellStore();
const repo = useRepoStore();
const settings = useSettingsStore();
const { openFolder } = useOpenFolder();
const external = useExternal();

const actions: PaletteActions = {
  hasRepository: () => repo.state.kind === "ready",
  openFolder: async () => {
    await openFolder();
  },
  closeRepository: () => repo.close(),
  setGraphFocus: () => void shell.setLayoutMode("graph"),
  setReviewFocus: () => void shell.setLayoutMode("review"),
  toggleSidebar: () => void shell.toggleSidebar(),
  openTerminal: async () => {
    await external.openTerminal();
  },
  openEditor: async () => {
    await external.openEditor();
  },
  setLocale: async (locale) => {
    await settings.update("locale", locale);
    setLocale(locale);
  },
};

const commands = computed(() => paletteCommands(actions));
const palette = usePalette({
  commands,
  translate: (key) => t(key),
  onClose: () => shell.closePalette(),
});

const icons: Record<string, typeof Search> = {
  "open-folder": FolderGit2,
  "graph-focus": GitGraph,
  "review-focus": FileDiff,
  "toggle-sidebar": PanelLeft,
  "open-terminal": Terminal,
  "open-editor": Code,
  "close-repository": X,
  "locale-en": Languages,
  "locale-es": Languages,
};

const input = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);

const sections = computed(() => {
  const recent = palette.rows.value.filter((row) => row.section === "recent");
  const rest = palette.rows.value.filter((row) => row.section === "commands");
  return [
    { id: "recent", label: t("palette.recent"), rows: recent, offset: 0 },
    { id: "commands", label: t("palette.commands"), rows: rest, offset: recent.length },
  ].filter((section) => section.rows.length > 0);
});

function hint(row: PaletteRow): string {
  return row.command.shortcutId ? shortcutRegistry().hint(row.command.shortcutId) : "";
}

onMounted(() => {
  void nextTick(() => input.value?.focus());
});

watch(
  () => palette.cursor.value,
  (index) => {
    list.value?.querySelector(`[data-index="${index}"]`)?.scrollIntoView?.({ block: "nearest" });
  },
);
</script>

<template>
  <div
    class="absolute inset-0 z-40 flex justify-center"
    data-testid="palette-overlay"
    @click.self="shell.closePalette()"
  >
    <div
      role="dialog"
      aria-modal="true"
      :aria-label="t('palette.placeholder')"
      class="palette flex max-h-full flex-col rounded-lg border border-line-strong bg-raised shadow-overlay"
    >
      <div class="flex items-center gap-3 border-b border-line px-3 py-2">
        <Search :size="16" :stroke-width="1.5" aria-hidden="true" class="text-fg-secondary" />
        <input
          ref="input"
          v-model="palette.query.value"
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="palette-list"
          :aria-expanded="!palette.isEmpty.value"
          :placeholder="t('palette.placeholder')"
          class="h-control min-w-0 flex-1 bg-transparent text-md text-fg outline-none placeholder:text-fg-muted"
          data-testid="palette-input"
          @keydown="palette.onKeydown"
        />
        <Kbd keys="esc" />
      </div>
      <div
        id="palette-list"
        ref="list"
        role="listbox"
        class="min-h-0 flex-1 overflow-y-auto p-1"
        data-testid="palette-list"
      >
        <template v-for="section in sections" :key="section.id">
          <p class="palette-section text-sm text-fg-muted">{{ section.label }}</p>
          <div
            v-for="(row, index) in section.rows"
            :key="`${section.id}-${row.command.id}`"
            role="option"
            :aria-selected="palette.cursor.value === section.offset + index"
            :data-index="section.offset + index"
            class="flex h-control cursor-default items-center gap-3 rounded-sm px-2 text-md text-fg"
            :class="
              palette.cursor.value === section.offset + index ? 'bg-selected' : 'hover:bg-hover'
            "
            data-testid="palette-row"
            @mousemove="palette.cursor.value = section.offset + index"
            @click="palette.run(row)"
          >
            <component
              :is="icons[row.command.id] ?? Search"
              :size="16"
              :stroke-width="1.5"
              aria-hidden="true"
              class="shrink-0 text-fg-secondary"
            />
            <span class="flex-1 truncate">{{ row.label }}</span>
            <Kbd v-if="hint(row)" :keys="hint(row)" />
          </div>
        </template>
        <p
          v-if="palette.isEmpty.value"
          class="palette-empty flex items-center justify-center px-3 text-center text-md text-fg-secondary"
          data-testid="palette-empty"
        >
          {{ t("palette.empty", { query: palette.query.value.trim() }) }}
        </p>
      </div>
      <div
        class="flex h-panel-header shrink-0 items-center gap-3 border-t border-line px-3 text-sm text-fg-muted"
      >
        <span class="flex items-center gap-2"><Kbd keys="↑↓" /> {{ t("palette.move") }}</span>
        <span class="flex items-center gap-2"><Kbd keys="↵" /> {{ t("palette.run") }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 640px wide, 40px from the top: the overlay's metrics, off the spacing scale. */
.palette {
  width: 640px;
  margin-top: 40px;
  max-height: calc(100% - 80px);
}

/* Section labels sit 8px under the previous rows (4px for the first) and about 2px above theirs. */
.palette-section {
  padding: var(--space-2) var(--space-2) 2px;
}

.palette-section:first-child {
  padding-top: var(--space-1);
}

/* The empty sentence is centred in a 135px area. */
.palette-empty {
  height: 135px;
}
</style>
