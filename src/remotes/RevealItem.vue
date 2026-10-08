<script setup lang="ts">
// "Reveal in Explorer" ("Reveal in Finder", "Open containing folder") in a menu: the file
// manager on a file or folder of the working tree at `root`, or on one of its worktrees.

import { FolderSearch } from "@lucide/vue";

import ContextMenuItem from "@/components/ContextMenuItem.vue";

import { useLinks } from "./useLinks";

const props = defineProps<{
  root: string;
  /** The item's absolute path. */
  path: string;
  /** How a toast names the item: a file's repository-relative path. */
  shown?: string;
}>();

const links = useLinks();
</script>

<template>
  <ContextMenuItem
    :label="links.revealLabel"
    :icon="FolderSearch"
    data-testid="menu-reveal"
    @select="() => void links.reveal(props.root, props.path, props.shown ?? props.path)"
  />
</template>
