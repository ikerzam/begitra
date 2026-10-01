<script setup lang="ts">
// The sidebar folded to its 48px rail (⌘B): one icon each for the Repositories section (while the
// project holds more than one repository), the branches and the worktrees. A click shows the
// sidebar with that section open, scrolled to the top and its list focused. Home, which has no
// sidebar, shows the icons disabled.

import { FolderGit2, GitBranch, ListTree } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";
import { useProjectsStore } from "@/stores/projects";
import type { SidebarSectionId } from "@/stores/settings";

const props = withDefaults(defineProps<{ disabled?: boolean }>(), { disabled: false });
const emit = defineEmits<{ select: [id: SidebarSectionId] }>();

const { t } = useI18n();
const projects = useProjectsStore();

const icons = computed(() => [
  ...(projects.activeMembers.length > 1
    ? [{ id: "repos" as const, icon: FolderGit2, label: "sidebar.repositories" }]
    : []),
  { id: "local" as const, icon: GitBranch, label: "sidebar.branches" },
  { id: "worktrees" as const, icon: ListTree, label: "sidebar.worktrees" },
]);
</script>

<template>
  <nav
    class="flex w-rail shrink-0 flex-col items-center gap-1 border-r border-line py-2"
    :aria-label="t('sidebar.expand')"
    data-testid="sidebar-rail"
  >
    <IconButton
      v-for="item in icons"
      :key="item.id"
      :label="t(item.label)"
      :icon="item.icon"
      size="lg"
      :disabled="props.disabled"
      :data-testid="`rail-${item.id}`"
      @click="emit('select', item.id)"
    />
  </nav>
</template>
