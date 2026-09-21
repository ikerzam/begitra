<script setup lang="ts">
// The menu of a branch row: Checkout (↵), Create branch here…, Merge into
// <current>, Rebase <current> onto this, Compare with… (⇧⌘C), Rename…, Set upstream…, Push
// (⇧⌘P), Delete…. A remote branch offers checkout (detached), create, merge, rebase and
// compare; a tag offers checkout, create, compare and delete tag.

import {
  Cloud,
  GitBranch,
  GitBranchPlus,
  GitCompareArrows,
  GitMerge,
  GitPullRequestArrow,
  Pencil,
  Tag,
  Trash2,
  Upload,
} from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import ContextMenu from "@/components/ContextMenu.vue";
import ContextMenuItem from "@/components/ContextMenuItem.vue";
import ContextMenuSeparator from "@/components/ContextMenuSeparator.vue";
import type { Ref as GitRef } from "@/ipc/schemas";
import { useShortcutHint } from "@/shortcuts/useShortcut";

const props = defineProps<{
  target: GitRef;
  /** The current branch, named in "Merge into" and "Rebase onto". */
  current: string | null;
  x: number;
  y: number;
}>();

const emit = defineEmits<{
  close: [];
  checkout: [];
  createHere: [];
  merge: [];
  rebase: [];
  compare: [];
  rename: [];
  setUpstream: [];
  push: [];
  delete: [];
  deleteTag: [];
}>();

const { t } = useI18n();
const compareHint = useShortcutHint("compare-with");
const pushHint = useShortcutHint("push");

const isLocal = computed(() => props.target.kind === "local-branch");
const isTag = computed(() => props.target.kind === "tag");
/** The current branch cannot be merged or rebased onto itself. */
const isCurrent = computed(() => props.target.isCurrent);
const currentName = computed(() => props.current ?? "HEAD");
</script>

<template>
  <ContextMenu :x="props.x" :y="props.y" :label="t('branches.menu')" @close="emit('close')">
    <ContextMenuItem
      :label="t('branches.checkout')"
      :icon="GitBranch"
      keys="↵"
      :disabled="isCurrent"
      data-testid="menu-checkout"
      @select="emit('checkout')"
    />
    <ContextMenuItem
      :label="t('branches.createHere')"
      :icon="GitBranchPlus"
      data-testid="menu-create"
      @select="emit('createHere')"
    />
    <ContextMenuSeparator />
    <template v-if="!isTag">
      <ContextMenuItem
        :label="t('branches.mergeInto', { branch: currentName })"
        :icon="GitMerge"
        :disabled="isCurrent || props.current === null"
        data-testid="menu-merge"
        @select="emit('merge')"
      />
      <ContextMenuItem
        :label="t('branches.rebaseOnto', { branch: currentName })"
        :icon="GitPullRequestArrow"
        :disabled="isCurrent || props.current === null"
        data-testid="menu-rebase"
        @select="emit('rebase')"
      />
    </template>
    <ContextMenuItem
      :label="t('branches.compareWith')"
      :icon="GitCompareArrows"
      :keys="compareHint"
      data-testid="menu-compare"
      @select="emit('compare')"
    />
    <template v-if="isLocal">
      <ContextMenuSeparator />
      <ContextMenuItem
        :label="t('branches.rename')"
        :icon="Pencil"
        data-testid="menu-rename"
        @select="emit('rename')"
      />
      <ContextMenuItem
        :label="t('branches.setUpstream')"
        :icon="Cloud"
        data-testid="menu-upstream"
        @select="emit('setUpstream')"
      />
      <ContextMenuItem
        :label="t('branches.push')"
        :icon="Upload"
        :keys="pushHint"
        data-testid="menu-push"
        @select="emit('push')"
      />
      <ContextMenuSeparator />
      <ContextMenuItem
        :label="t('branches.delete')"
        :icon="Trash2"
        :disabled="isCurrent"
        destructive
        data-testid="menu-delete"
        @select="emit('delete')"
      />
    </template>
    <template v-else-if="isTag">
      <ContextMenuSeparator />
      <ContextMenuItem
        :label="t('branches.deleteTag')"
        :icon="Tag"
        destructive
        data-testid="menu-delete-tag"
        @select="emit('deleteTag')"
      />
    </template>
  </ContextMenu>
</template>
