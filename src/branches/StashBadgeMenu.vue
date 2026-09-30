<script setup lang="ts">
// The menu of the stash badge on a graph row: Apply, Pop, Copy stash name, Copy hash, Drop…
// (the stash sheet's own confirmation); never a branch's actions, which would run against the
// stash's commit. The writes wait while another stash write runs, as the sheet's buttons do.

import { ArchiveRestore, Copy, PackageOpen, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ContextMenu from "@/components/ContextMenu.vue";
import ContextMenuItem from "@/components/ContextMenuItem.vue";
import ContextMenuSeparator from "@/components/ContextMenuSeparator.vue";

import type { StashAction } from "./useBranchActions";

const props = defineProps<{ x: number; y: number; busy: boolean }>();

const emit = defineEmits<{ close: []; choose: [kind: StashAction] }>();

const { t } = useI18n();
</script>

<template>
  <ContextMenu :x="props.x" :y="props.y" :label="t('stash.menu')" @close="emit('close')">
    <ContextMenuItem
      :label="t('stash.apply')"
      :icon="ArchiveRestore"
      :disabled="props.busy"
      data-testid="menu-stash-apply"
      @select="emit('choose', 'apply')"
    />
    <ContextMenuItem
      :label="t('stash.pop')"
      :icon="PackageOpen"
      :disabled="props.busy"
      data-testid="menu-stash-pop"
      @select="emit('choose', 'pop')"
    />
    <ContextMenuSeparator />
    <ContextMenuItem
      :label="t('stash.copyName')"
      :icon="Copy"
      data-testid="menu-stash-copy-name"
      @select="emit('choose', 'copyName')"
    />
    <ContextMenuItem
      :label="t('graph.copyHash')"
      :icon="Copy"
      data-testid="menu-stash-copy-hash"
      @select="emit('choose', 'copyHash')"
    />
    <ContextMenuSeparator />
    <ContextMenuItem
      :label="t('stash.dropEllipsis')"
      :icon="Trash2"
      :disabled="props.busy"
      destructive
      data-testid="menu-stash-drop"
      @select="emit('choose', 'drop')"
    />
  </ContextMenu>
</template>
