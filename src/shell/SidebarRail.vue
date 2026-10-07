<script setup lang="ts">
// The sidebar: a 48px rail, the same in every layout while a project is open (Home has none). One
// icon per panel (`sidebarPanels`): the project's Repositories while it holds more than one
// repository or worktree, then Branches, Remote branches, Tags and Worktrees. A click opens the
// icon's panel over the main area, or closes it when it is the open one, whose icon shows pressed.
// The Worktrees icon carries the alert while the worktrees cannot be listed. The rail reads the
// worktrees once the repository is ready, so their panel opens on a known list, and clears the
// panels' filters when another repository shows.

import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";
import { useProjectsStore } from "@/stores/projects";
import { useRepoStore } from "@/stores/repo";
import { useShellStore } from "@/stores/shell";

import { SIDEBAR_PANELS } from "./sidebarPanels";

const { t } = useI18n();
const shell = useShellStore();
const repo = useRepoStore();
const projects = useProjectsStore();

watch(
  () => repo.state.kind,
  (kind) => {
    if (kind === "ready") void repo.loadWorktrees();
  },
  { immediate: true },
);

watch(
  () => repo.repo?.root,
  (root, before) => {
    if (root !== before) shell.clearSidebarFilters();
  },
);

const worktreesFailed = computed(() => repo.state.kind === "ready" && repo.worktreesError !== null);

const panels = computed(() =>
  SIDEBAR_PANELS.filter((panel) => panel.id !== "repos" || projects.activeMembers.length > 1),
);

/* A project of one has no Repositories panel: one open from the last project closes. */
watch(panels, (shown) => {
  const open = shell.sidebarPanel;
  if (open !== null && !shown.some((panel) => panel.id === open)) shell.closeSidebarPanel();
});
</script>

<template>
  <nav
    class="flex w-rail shrink-0 flex-col items-center gap-1 border-r border-line py-2"
    :aria-label="t('sidebar.label')"
    data-testid="sidebar-rail"
  >
    <div v-for="panel in panels" :key="panel.id" class="relative">
      <IconButton
        :label="t(panel.title)"
        :tooltip="
          panel.id === 'worktrees' && worktreesFailed
            ? `${t(panel.title)} · ${t('sidebar.worktreesUnlisted')}`
            : undefined
        "
        :icon="panel.icon"
        size="lg"
        :pressed="shell.sidebarPanel === panel.id"
        :aria-controls="shell.sidebarPanel === panel.id ? 'sidebar-panel' : undefined"
        :data-testid="`rail-${panel.id}`"
        @click="shell.toggleSidebarPanel(panel.id)"
      />
      <span
        v-if="panel.id === 'worktrees' && worktreesFailed"
        class="rail-alert pointer-events-none absolute top-1 right-1 rounded-full bg-danger"
        aria-hidden="true"
        data-testid="rail-worktrees-alert"
      />
    </div>
  </nav>
</template>

<style scoped>
/* The alert is a 6px dot, as `DirtyDot` draws; the spacing scale has no 6. */
.rail-alert {
  width: 6px;
  height: 6px;
}
</style>
