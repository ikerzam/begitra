<script setup lang="ts">
// The menu of a repository row: pin or unpin, open in terminal or editor, remove from the
// list. Fixed at the given viewport position (a right click, the "…", or the keyboard).

import { Code, ListX, Pin, PinOff, Terminal } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ContextMenu from "@/components/ContextMenu.vue";
import ContextMenuItem from "@/components/ContextMenuItem.vue";
import ContextMenuSeparator from "@/components/ContextMenuSeparator.vue";
import type { IndexEntry } from "@/ipc/schemas";

import { useRepoActions } from "./useRepoActions";

const props = defineProps<{ entry: IndexEntry; x: number; y: number }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const actions = useRepoActions();
</script>

<template>
  <ContextMenu
    :x="props.x"
    :y="props.y"
    :label="t('home.rowActions', { name: props.entry.name })"
    data-testid="repo-row-menu"
    @close="emit('close')"
  >
    <ContextMenuItem
      :label="props.entry.pinned ? t('home.unpin') : t('home.pin')"
      :icon="props.entry.pinned ? PinOff : Pin"
      data-testid="menu-pin"
      @select="() => void actions.togglePin(props.entry)"
    />
    <ContextMenuItem
      :label="t('palette.commandsById.open-terminal')"
      :icon="Terminal"
      data-testid="menu-terminal"
      @select="() => void actions.openTerminal(props.entry)"
    />
    <ContextMenuItem
      :label="t('palette.commandsById.open-editor')"
      :icon="Code"
      data-testid="menu-editor"
      @select="() => void actions.openEditor(props.entry)"
    />
    <ContextMenuSeparator />
    <ContextMenuItem
      :label="t('home.removeFromList')"
      :icon="ListX"
      data-testid="menu-forget"
      @select="() => void actions.forget(props.entry)"
    />
  </ContextMenu>
</template>
