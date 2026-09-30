<script setup lang="ts">
// The menu of a branch row or a ref badge, by the ref's kind. A local branch:
// Checkout (↵), Create branch here…, Merge into <current>, Rebase <current> onto this, Compare
// with… (⇧⌘C), Rename…, Set upstream…, Push (⇧⌘P), Copy branch name, Delete…. A remote branch:
// Checkout (a local branch that tracks it), create, merge, rebase, compare, Pull into
// <current>…, Fetch <remote>, copy, Delete on <remote>…. A tag: Checkout (detached), create,
// compare, Push tag…, copy, Delete tag…. The stash badge has a menu of its own (StashBadgeMenu).

import {
  Cloud,
  Copy,
  Download,
  GitBranch,
  GitBranchPlus,
  GitCompareArrows,
  GitMerge,
  GitPullRequestArrow,
  Pencil,
  RefreshCw,
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

import type { RemoteBranch } from "./names";
import type { BranchAction } from "./useBranchActions";

const props = defineProps<{
  target: GitRef;
  /** The current branch, named in "Merge into", "Rebase onto" and "Pull into". */
  current: string | null;
  /** A remote branch's remote and name there; null leaves out the items that need one. */
  remote?: RemoteBranch | null;
  /** Whether ↵ on the ref's row checks it out (the sidebar's rows), for the hint. */
  enterChecksOut?: boolean;
  x: number;
  y: number;
}>();

const emit = defineEmits<{ close: []; choose: [kind: BranchAction] }>();

const { t } = useI18n();
const compareHint = useShortcutHint("compare-with");
const pushHint = useShortcutHint("push");

const isLocal = computed(() => props.target.kind === "local-branch");
const isRemote = computed(() => props.target.kind === "remote-branch");
const isTag = computed(() => props.target.kind === "tag");
/** The current branch cannot be merged or rebased onto itself. */
const isCurrent = computed(() => props.target.isCurrent);
const currentName = computed(() => props.current ?? "HEAD");
/** A remote branch's actions on its remote need the remote. */
const remoteName = computed(() => props.remote?.remote ?? null);
/** Nothing to check out: the ref is HEAD's, or a remote branch whose local branch is. */
const checkoutDisabled = computed(
  () => isCurrent.value || (isRemote.value && props.remote?.branch === props.current),
);
const label = computed(() =>
  t(isTag.value ? "branches.menuTag" : isRemote.value ? "branches.menuRemote" : "branches.menu"),
);
</script>

<template>
  <ContextMenu :x="props.x" :y="props.y" :label="label" @close="emit('close')">
    <ContextMenuItem
      :label="isTag ? t('branches.checkoutDetached') : t('branches.checkout')"
      :icon="GitBranch"
      :keys="props.enterChecksOut ? '↵' : undefined"
      :disabled="checkoutDisabled"
      data-testid="menu-checkout"
      @select="emit('choose', 'checkout')"
    />
    <ContextMenuItem
      :label="t('branches.createHere')"
      :icon="GitBranchPlus"
      data-testid="menu-create"
      @select="emit('choose', 'createHere')"
    />
    <ContextMenuSeparator />
    <template v-if="!isTag">
      <ContextMenuItem
        :label="t('branches.mergeInto', { branch: currentName })"
        :icon="GitMerge"
        :disabled="isCurrent || props.current === null"
        data-testid="menu-merge"
        @select="emit('choose', 'merge')"
      />
      <ContextMenuItem
        :label="t('branches.rebaseOnto', { branch: currentName })"
        :icon="GitPullRequestArrow"
        :disabled="isCurrent || props.current === null"
        data-testid="menu-rebase"
        @select="emit('choose', 'rebase')"
      />
    </template>
    <ContextMenuItem
      :label="t('branches.compareWith')"
      :icon="GitCompareArrows"
      :keys="compareHint"
      data-testid="menu-compare"
      @select="emit('choose', 'compare')"
    />
    <template v-if="isRemote && remoteName !== null">
      <ContextMenuSeparator />
      <ContextMenuItem
        :label="t('branches.pullInto', { branch: currentName })"
        :icon="Download"
        :disabled="props.current === null"
        data-testid="menu-pull-into"
        @select="emit('choose', 'pullInto')"
      />
      <ContextMenuItem
        :label="t('branches.fetchRemote', { remote: remoteName })"
        :icon="RefreshCw"
        data-testid="menu-fetch-remote"
        @select="emit('choose', 'fetchRemote')"
      />
    </template>
    <template v-if="isLocal">
      <ContextMenuSeparator />
      <ContextMenuItem
        :label="t('branches.rename')"
        :icon="Pencil"
        data-testid="menu-rename"
        @select="emit('choose', 'rename')"
      />
      <ContextMenuItem
        :label="t('branches.setUpstream')"
        :icon="Cloud"
        data-testid="menu-upstream"
        @select="emit('choose', 'setUpstream')"
      />
      <ContextMenuItem
        :label="t('branches.push')"
        :icon="Upload"
        :keys="pushHint"
        data-testid="menu-push"
        @select="emit('choose', 'push')"
      />
    </template>
    <ContextMenuItem
      v-if="isTag"
      :label="t('branches.pushTag')"
      :icon="Upload"
      data-testid="menu-push-tag"
      @select="emit('choose', 'pushTag')"
    />
    <ContextMenuSeparator />
    <ContextMenuItem
      :label="isTag ? t('branches.copyTagName') : t('branches.copyBranchName')"
      :icon="Copy"
      data-testid="menu-copy-name"
      @select="emit('choose', 'copyName')"
    />
    <template v-if="isLocal || isTag || remoteName !== null">
      <ContextMenuSeparator />
      <ContextMenuItem
        v-if="isLocal"
        :label="t('branches.delete')"
        :icon="Trash2"
        :disabled="isCurrent"
        destructive
        data-testid="menu-delete"
        @select="emit('choose', 'delete')"
      />
      <ContextMenuItem
        v-else-if="isTag"
        :label="t('branches.deleteTag')"
        :icon="Trash2"
        destructive
        data-testid="menu-delete-tag"
        @select="emit('choose', 'deleteTag')"
      />
      <ContextMenuItem
        v-else
        :label="t('branches.deleteOnRemote', { remote: remoteName })"
        :icon="Trash2"
        destructive
        data-testid="menu-delete-on-remote"
        @select="emit('choose', 'deleteOnRemote')"
      />
    </template>
  </ContextMenu>
</template>
