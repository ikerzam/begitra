<script setup lang="ts">
import { FolderGit2, GitBranch, ListTree } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";
import type { SidebarTab } from "@/stores/shell";

const props = defineProps<{ active: SidebarTab }>();
const emit = defineEmits<{ select: [tab: SidebarTab] }>();

const { t } = useI18n();
const tabs: { id: SidebarTab; icon: typeof FolderGit2; label: string }[] = [
  { id: "repos", icon: FolderGit2, label: "sidebar.repos" },
  { id: "branches", icon: GitBranch, label: "sidebar.branches" },
  { id: "worktrees", icon: ListTree, label: "sidebar.worktrees" },
];
</script>

<template>
  <nav
    class="flex w-rail shrink-0 flex-col items-center gap-1 border-r border-line py-2"
    :aria-label="t('sidebar.expand')"
    data-testid="sidebar-rail"
  >
    <IconButton
      v-for="tab in tabs"
      :key="tab.id"
      :label="t(tab.label)"
      :icon="tab.icon"
      :pressed="props.active === tab.id"
      :data-testid="`rail-${tab.id}`"
      @click="emit('select', tab.id)"
    />
  </nav>
</template>
