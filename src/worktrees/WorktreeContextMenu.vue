<script setup lang="ts">
// The context menu of a worktree row: the row's actions plus Lock or Unlock. Opened at the
// pointer, or under the focused row from the menu key.

import { Code, FileDiff, Lock, LockOpen, Terminal, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ContextMenu from "@/components/ContextMenu.vue";
import ContextMenuItem from "@/components/ContextMenuItem.vue";
import ContextMenuSeparator from "@/components/ContextMenuSeparator.vue";
import type { WorktreeRow } from "@/stores/worktrees";

const props = defineProps<{ row: WorktreeRow; x: number; y: number }>();
const emit = defineEmits<{
  compare: [];
  openTerminal: [];
  openEditor: [];
  lock: [];
  unlock: [];
  remove: [];
  close: [];
}>();

const { t } = useI18n();
</script>

<template>
  <ContextMenu :x="props.x" :y="props.y" :label="t('worktrees.rowMenu')" @close="emit('close')">
    <ContextMenuItem
      v-if="!props.row.isMain && !props.row.prunable"
      :label="t('worktreeRow.compare')"
      :icon="FileDiff"
      data-testid="menu-compare-main"
      @select="emit('compare')"
    />
    <ContextMenuItem
      :label="t('worktreeRow.terminal')"
      :icon="Terminal"
      @select="emit('openTerminal')"
    />
    <ContextMenuItem :label="t('worktreeRow.editor')" :icon="Code" @select="emit('openEditor')" />
    <template v-if="!props.row.isMain">
      <ContextMenuSeparator />
      <ContextMenuItem
        v-if="props.row.locked"
        :label="t('worktrees.unlock')"
        :icon="LockOpen"
        data-testid="menu-unlock"
        @select="emit('unlock')"
      />
      <ContextMenuItem
        v-else
        :label="t('worktreeRow.lock')"
        :icon="Lock"
        data-testid="menu-lock"
        @select="emit('lock')"
      />
      <ContextMenuItem
        :label="t('worktrees.removeMenu')"
        :icon="Trash2"
        destructive
        data-testid="menu-remove"
        @select="emit('remove')"
      />
    </template>
  </ContextMenu>
</template>
