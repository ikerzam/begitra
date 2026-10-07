<script setup lang="ts">
// A sidebar panel: one section of the sidebar, floating over the main area beside the rail. Its
// header names the section with its count ("2 of 12" while its filter narrows it) and carries the
// section's actions (the branch order and Clean up in Branches, the dashboard in Worktrees); its
// filter is its own and stays while the panel is closed; its list is the section's, with its rows,
// keys and menus. Escape (the focus back on its rail icon), the icon, ⌘B, a row's activation and a
// press outside it close it; a press in a dialog or a menu does not, so a row menu's dialog keeps
// it. The layout behind never moves: the panel floats, resizable from its right edge.

import { ArrowDownAZ, BrushCleaning, ClockArrowDown, LayoutList, Search } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, provide, ref } from "vue";
import { useI18n } from "vue-i18n";

import { useBranchActions } from "@/branches/useBranchActions";
import IconButton from "@/components/IconButton.vue";
import Input from "@/components/Input.vue";
import { isOverlayTarget } from "@/shortcuts/registry";
import { useCleanupStore } from "@/stores/cleanup";
import { useRepoStore } from "@/stores/repo";
import { useSettingsStore, type SidebarSectionId } from "@/stores/settings";
import { paneLimits, useShellStore } from "@/stores/shell";

import BranchList from "./BranchList.vue";
import PaneResizer from "./PaneResizer.vue";
import RepoList from "./RepoList.vue";
import { panelTitle } from "./sidebarPanels";
import { branchSelectionKey, useBranchSelection } from "./useBranchSelection";
import { useSidebarSections } from "./useSidebarSections";
import WorktreeList from "./WorktreeList.vue";

const props = defineProps<{ id: SidebarSectionId }>();

const { t, n } = useI18n();
const shell = useShellStore();
const settings = useSettingsStore();
const repo = useRepoStore();
const cleanup = useCleanupStore();
const actions = useBranchActions();

/* One branch selection for the ref lists, as the column had: a scope still pending when one ref
   panel gives way to another settles once. */
const branchSelection = useBranchSelection();
provide(branchSelectionKey, branchSelection);
onUnmounted(branchSelection.dispose);

const filter = computed({
  get: () => shell.sidebarFilters[props.id],
  set: (value: string) => shell.setSidebarFilter(props.id, value),
});
const filtering = computed(() => filter.value.trim() !== "");
const { rows, totals } = useSidebarSections(filter);
const title = computed(() => t(panelTitle(props.id)));
/** The kind of refs a ref panel lists; null for the repositories and the worktrees. */
const refKind = computed(() =>
  props.id === "local" || props.id === "remote" || props.id === "tags" ? props.id : null,
);

/** Whether the panel's rows are being read: skeleton rows and no count meanwhile. */
const reading = computed(() => {
  if (props.id === "repos") return false;
  if (repo.state.kind === "opening") return true;
  if (repo.state.kind !== "ready") return false;
  return props.id === "worktrees" ? !repo.worktreesLoaded : !repo.refsLoaded;
});
const worktreesFailed = computed(() => repo.state.kind === "ready" && repo.worktreesError !== null);

/** "12", or "2 of 12" while the filter narrows the list; none while it is read or failed. */
const count = computed(() => {
  if (reading.value || (props.id === "worktrees" && worktreesFailed.value)) return "";
  const total = totals.value[props.id];
  return filtering.value
    ? t("sidebar.countOf", { n: n(rows.value[props.id].length), m: n(total) })
    : n(total);
});

/* The branch order toggle names, and shows, the order it switches to. */
const byRecent = computed(() => settings.values.branchSort === "recent");
function toggleBranchSort(): void {
  void settings.update("branchSort", byRecent.value ? "name" : "recent");
}

/* The worktrees dashboard, from the Worktrees panel's header: the panel closes on it. */
const repoReady = computed(() => repo.state.kind === "ready");
const dashboardShown = computed(() => repoReady.value && shell.layoutMode === "worktrees");
function toggleDashboard(): void {
  shell.closeSidebarPanel();
  void shell.setLayoutMode(dashboardShown.value ? "graph" : "worktrees");
}

const panel = ref<HTMLElement | null>(null);
const list = ref<{ focus: () => void } | null>(null);
const filterField = ref<{ $el: HTMLElement } | null>(null);

/** The rail icon of this panel, where Escape gives the focus back. */
const railIcon = () =>
  document.querySelector<HTMLElement>(`[data-testid="rail-${props.id}"]`) ?? null;

/** Escape closes the panel; one a menu or a dialog inside takes is theirs. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  if (isOverlayTarget(event.target)) return;
  event.preventDefault();
  const icon = railIcon();
  shell.closeSidebarPanel();
  icon?.focus();
}

/**
 * A press outside the panel and the rail closes it and goes on to what it pressed; one in a
 * dialog, a menu or a popover (a row menu's dialog) leaves it open.
 */
function onPointerDown(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node) || panel.value?.contains(target)) return;
  if (target instanceof Element && target.closest('[data-testid="sidebar-rail"]')) return;
  if (isOverlayTarget(target)) return;
  shell.closeSidebarPanel();
}

onMounted(() => {
  document.addEventListener("pointerdown", onPointerDown, true);
  // The list takes the focus (its selected row, else its first); with no row, the filter.
  void nextTick(() => {
    const before = document.activeElement;
    list.value?.focus();
    if (document.activeElement === before) {
      filterField.value?.$el.querySelector("input")?.focus();
    }
  });
});
onBeforeUnmount(() => document.removeEventListener("pointerdown", onPointerDown, true));
</script>

<template>
  <aside
    id="sidebar-panel"
    ref="panel"
    class="sidebar-panel absolute inset-y-0 left-rail z-10 flex flex-col border-r border-line-strong bg-raised shadow-overlay"
    :style="{ width: `${shell.paneSizes.sidebar}px` }"
    :aria-label="title"
    data-testid="sidebar-panel"
    :data-panel="props.id"
    @keydown="onKeydown"
  >
    <div class="flex h-panel-header shrink-0 items-center gap-2 pr-2 pl-3">
      <h2 class="text-md font-medium text-fg" data-testid="sidebar-panel-title">{{ title }}</h2>
      <span class="text-sm text-fg-muted tabular-nums" data-testid="sidebar-panel-count">
        {{ count }}
      </span>
      <span class="flex-1" />
      <template v-if="props.id === 'local'">
        <IconButton
          :icon="byRecent ? ArrowDownAZ : ClockArrowDown"
          :label="byRecent ? t('sidebar.sortByName') : t('sidebar.sortByRecent')"
          data-testid="branch-sort"
          @click="toggleBranchSort"
        />
        <IconButton
          :icon="BrushCleaning"
          :label="t('palette.commandsById.clean-up-branches')"
          :disabled="!repoReady"
          data-testid="branch-cleanup"
          @click="cleanup.open()"
        />
      </template>
      <IconButton
        v-else-if="props.id === 'worktrees'"
        :icon="LayoutList"
        :label="t('palette.commandsById.show-worktrees')"
        :pressed="dashboardShown"
        :disabled="!repoReady"
        data-testid="sidebar-dashboard"
        @click="toggleDashboard"
      />
    </div>
    <div class="shrink-0 px-2 pb-2">
      <Input
        ref="filterField"
        v-model="filter"
        :placeholder="t('sidebar.filter')"
        :icon="Search"
        data-testid="sidebar-filter"
      />
    </div>
    <div class="sidebar-panel-list min-h-0 flex-1 overflow-y-auto pb-2">
      <p
        v-if="filtering && rows[props.id].length === 0"
        class="px-3 py-2 text-md text-fg-secondary"
        data-testid="panel-no-matches"
      >
        {{ t("sidebar.noMatches") }}
      </p>
      <RepoList
        v-else-if="props.id === 'repos'"
        ref="list"
        :rows="rows.repos"
        @activated="shell.closeSidebarPanel()"
      />
      <WorktreeList
        v-else-if="props.id === 'worktrees'"
        ref="list"
        :rows="rows.worktrees"
        @activated="shell.closeSidebarPanel()"
      />
      <BranchList
        v-else-if="refKind"
        ref="list"
        :rows="rows[refKind]"
        :kind="refKind"
        :label="title"
        @action="actions.run"
        @activated="shell.closeSidebarPanel()"
      />
    </div>
    <div class="absolute inset-y-0 right-0">
      <PaneResizer
        class="h-full"
        :size="shell.paneSizes.sidebar"
        :min="paneLimits.sidebar.min"
        :max="paneLimits.sidebar.max"
        :label="t('layout.resizeSidebar')"
        @resize="(px) => void shell.setPaneSize('sidebar', px)"
        @reset="() => void shell.resetPaneSize('sidebar')"
      />
    </div>
  </aside>
</template>

<style scoped>
/* The rows' ring goes inside: the panel clips their sides. */
.sidebar-panel-list :deep([role="option"]:focus-visible) {
  outline-offset: -2px;
}
</style>
