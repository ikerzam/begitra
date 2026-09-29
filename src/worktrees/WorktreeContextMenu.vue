<script setup lang="ts">
// The context menu of a worktree row: the row's actions plus Lock or Unlock. Opened at the
// pointer, or under the focused row from the menu key. The sidebar's Worktrees tab opens it
// without the actions that ask in a dialog (lock, unlock, remove), which the dashboard holds,
// and with Terminal and Editor disabled for a folder that is gone: the dashboard's banner
// explains that one and offers the prune, the sidebar has no place to.

import { Code, FileDiff, Lock, LockOpen, Terminal, Trash2 } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import ContextMenu from "@/components/ContextMenu.vue";
import ContextMenuItem from "@/components/ContextMenuItem.vue";
import ContextMenuSeparator from "@/components/ContextMenuSeparator.vue";
import type { WorktreeRow } from "@/stores/worktrees";

const props = withDefaults(
  defineProps<{
    row: WorktreeRow;
    x: number;
    y: number;
    /** Whether the actions that ask in a dialog are offered (not in the sidebar). */
    dialogs?: boolean;
  }>(),
  { dialogs: true },
);
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

/** The sidebar offers nothing to open in a folder that is gone. */
const gone = computed(() => !props.dialogs && props.row.prunable);
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
      :disabled="gone"
      data-testid="menu-terminal"
      @select="emit('openTerminal')"
    />
    <ContextMenuItem
      :label="t('worktreeRow.editor')"
      :icon="Code"
      :disabled="gone"
      data-testid="menu-editor"
      @select="emit('openEditor')"
    />
    <template v-if="props.dialogs && !props.row.isMain">
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
