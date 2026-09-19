<script setup lang="ts">
// The 240px sidebar: the three tabs, one filter input and the list of the active tab.

import { Search } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import Input from "@/components/Input.vue";
import { useShellStore } from "@/stores/shell";

import BranchList from "./BranchList.vue";
import RepoList from "./RepoList.vue";
import SidebarTabs from "./SidebarTabs.vue";
import WorktreeList from "./WorktreeList.vue";

const { t } = useI18n();
const shell = useShellStore();

const filter = ref("");

const filterPlaceholder = computed(() => {
  switch (shell.sidebarTab) {
    case "repos":
      return t("sidebar.filterRepos");
    case "worktrees":
      return t("sidebar.filterWorktrees");
    default:
      return t("sidebar.filterBranches");
  }
});
</script>

<template>
  <aside class="flex w-sidebar shrink-0 flex-col border-r border-line" data-testid="sidebar">
    <SidebarTabs :active="shell.sidebarTab" @select="shell.setSidebarTab" />
    <div class="px-2 py-2">
      <Input v-model="filter" :placeholder="filterPlaceholder" :icon="Search" />
    </div>
    <BranchList v-if="shell.sidebarTab === 'branches'" :filter="filter" />
    <RepoList v-else-if="shell.sidebarTab === 'repos'" />
    <WorktreeList v-else :filter="filter" />
  </aside>
</template>
