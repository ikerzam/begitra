<script setup lang="ts">
// The context menu of a commit row: copy hash and message, diff from
// here, compare with…, select as range end, open in terminal and in
// editor. Opened at the pointer, or under the focused row from the keyboard.

import { Code, Copy, FileDiff, GitCommitHorizontal, GitCompareArrows, Terminal } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ContextMenu from "@/components/ContextMenu.vue";
import ContextMenuItem from "@/components/ContextMenuItem.vue";
import ContextMenuSeparator from "@/components/ContextMenuSeparator.vue";
import { formatShortcut } from "@/shortcuts/platform";
import { shortcutRegistry } from "@/shortcuts/registry";

const props = defineProps<{ x: number; y: number }>();
const emit = defineEmits<{
  copyHash: [];
  copyMessage: [];
  diffFrom: [];
  compareWith: [];
  rangeEnd: [];
  openTerminal: [];
  openEditor: [];
  close: [];
}>();

const { t } = useI18n();
/* Copy is the platform's own shortcut, not a rebindable command. */
const copyHint = formatShortcut("mod+c", shortcutRegistry().platform);
</script>

<template>
  <ContextMenu :x="props.x" :y="props.y" :label="t('graph.commitMenu')" @close="emit('close')">
    <ContextMenuItem
      :label="t('graph.copyHash')"
      :icon="Copy"
      :keys="copyHint"
      data-testid="menu-copy-hash"
      @select="emit('copyHash')"
    />
    <ContextMenuItem :label="t('graph.copyMessage')" :icon="Copy" @select="emit('copyMessage')" />
    <ContextMenuSeparator />
    <ContextMenuItem
      :label="t('graph.diffFromHere')"
      :icon="FileDiff"
      data-testid="menu-diff-from"
      @select="emit('diffFrom')"
    />
    <ContextMenuItem
      :label="t('graph.compareWith')"
      :icon="GitCompareArrows"
      data-testid="menu-compare"
      @select="emit('compareWith')"
    />
    <ContextMenuItem
      :label="t('graph.selectRangeEnd')"
      :icon="GitCommitHorizontal"
      data-testid="menu-range-end"
      @select="emit('rangeEnd')"
    />
    <ContextMenuSeparator />
    <ContextMenuItem
      :label="t('palette.commandsById.open-terminal')"
      :icon="Terminal"
      @select="emit('openTerminal')"
    />
    <ContextMenuItem
      :label="t('palette.commandsById.open-editor')"
      :icon="Code"
      @select="emit('openEditor')"
    />
  </ContextMenu>
</template>
