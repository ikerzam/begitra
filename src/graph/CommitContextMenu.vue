<script setup lang="ts">
// The context menu of a commit row: copy hash and message, diff from
// here, compare with…, select as range end, the branch actions on the commit (HEAD's row
// adds "Undo commit"), open in terminal and in editor. Opened at the pointer, or under the
// focused row from the keyboard.

import {
  Code,
  Copy,
  FileDiff,
  GitBranchPlus,
  GitCommitHorizontal,
  GitCompareArrows,
  RotateCcw,
  Tag,
  Terminal,
  Undo2,
  UndoDot,
  Waypoints,
} from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ContextMenu from "@/components/ContextMenu.vue";
import ContextMenuItem from "@/components/ContextMenuItem.vue";
import ContextMenuSeparator from "@/components/ContextMenuSeparator.vue";
import { formatShortcut } from "@/shortcuts/platform";
import { shortcutRegistry } from "@/shortcuts/registry";

const props = defineProps<{
  x: number;
  y: number;
  /** The current branch, named in "Reset <branch> to here"; null when detached. */
  branch?: string | null;
  /** The row is HEAD's commit, which "Undo commit" moves back from. */
  head?: boolean;
}>();
const emit = defineEmits<{
  copyHash: [];
  copyMessage: [];
  diffFrom: [];
  compareWith: [];
  rangeEnd: [];
  createBranch: [];
  tag: [];
  cherryPick: [];
  revert: [];
  undo: [];
  reset: [];
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
      :label="t('branches.createHere')"
      :icon="GitBranchPlus"
      data-testid="menu-create-branch"
      @select="emit('createBranch')"
    />
    <ContextMenuItem
      :label="t('branches.tagHere')"
      :icon="Tag"
      data-testid="menu-tag"
      @select="emit('tag')"
    />
    <ContextMenuItem
      :label="t('branches.cherryPick')"
      :icon="Waypoints"
      data-testid="menu-cherry-pick"
      @select="emit('cherryPick')"
    />
    <ContextMenuItem
      :label="t('branches.revert')"
      :icon="Undo2"
      data-testid="menu-revert"
      @select="emit('revert')"
    />
    <ContextMenuItem
      v-if="props.head"
      :label="t('branches.undoCommit')"
      :icon="UndoDot"
      data-testid="menu-undo-commit"
      @select="emit('undo')"
    />
    <ContextMenuItem
      :label="t('branches.resetHere', { branch: props.branch ?? 'HEAD' })"
      :icon="RotateCcw"
      destructive
      data-testid="menu-reset"
      @select="emit('reset')"
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
