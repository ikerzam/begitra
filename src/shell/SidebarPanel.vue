<script setup lang="ts">
// The sidebar's panel: the section chosen on the rail, docked beside it, the layout taking the
// rest of the width. Its header names the section with its count ("2 of 12" while its filter
// narrows it) and carries the section's actions (the branch order and Clean up in Branches, the
// dashboard in Worktrees); its filter is the section's own and stays while another section
// shows or the panel is closed; its list is the section's, with its rows, keys and menus, which
// act without closing anything. Opened or shown from the rail or ⌘B, it focuses its list;
// Escape hands the focus to the layout (`leave`). Resizable from its right edge.

import { ArrowDownAZ, BrushCleaning, ClockArrowDown, LayoutList, Search } from "@lucide/vue";
import { computed, nextTick, onMounted, onUnmounted, provide, ref } from "vue";
import { useI18n } from "vue-i18n";

import { useBranchActions } from "@/branches/useBranchActions";
import IconButton from "@/components/IconButton.vue";
import Input from "@/components/Input.vue";
import { isOverlayTarget } from "@/shortcuts/registry";
import { useCleanupStore } from "@/stores/cleanup";
import { useRepoStore } from "@/stores/repo";
import { useSettingsStore } from "@/stores/settings";
import { paneLimits, useShellStore, type SidebarSectionId } from "@/stores/shell";

import BranchList from "./BranchList.vue";
import PaneResizer from "./PaneResizer.vue";
import RepoList from "./RepoList.vue";
import { panelTitle } from "./sidebarPanels";
import { branchSelectionKey, useBranchSelection } from "./useBranchSelection";
import { useSidebarSection } from "./useSidebarSection";
import WorktreeList from "./WorktreeList.vue";

const props = defineProps<{ id: SidebarSectionId }>();
/** Escape in the panel, or the dashboard shown from it: the shell gives the layout's list the
 * focus. */
const emit = defineEmits<{ leave: [] }>();

const { t, n } = useI18n();
const shell = useShellStore();
const settings = useSettingsStore();
const repo = useRepoStore();
const cleanup = useCleanupStore();
const actions = useBranchActions();

/* The ref list's branch selection: a scope still pending when the section goes applies then. */
const branchSelection = useBranchSelection();
provide(branchSelectionKey, branchSelection);
onUnmounted(branchSelection.flush);

const filter = computed({
  get: () => shell.sidebarFilters[props.id],
  set: (value: string) => shell.setSidebarFilter(props.id, value),
});
const filtering = computed(() => filter.value.trim() !== "");
const { rows, total } = useSidebarSection(props.id, filter);
const title = computed(() => t(panelTitle(props.id)));
/** The kind of refs a ref section lists; null for the repositories and the worktrees. */
const refKind = computed(() =>
  props.id === "local" || props.id === "remote" || props.id === "tags" ? props.id : null,
);

/** Whether the section's rows are being read: skeleton rows and no count meanwhile. */
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
  return filtering.value
    ? t("sidebar.countOf", { n: n(rows.value[props.id].length), m: n(total.value) })
    : n(total.value);
});

/* The branch order toggle names, and shows, the order it switches to. */
const byRecent = computed(() => settings.values.branchSort === "recent");
function toggleBranchSort(): void {
  void settings.update("branchSort", byRecent.value ? "name" : "recent");
}

/* The worktrees dashboard, from the Worktrees section's header: its tab shows, its rows taking
   the focus. */
const repoReady = computed(() => repo.state.kind === "ready");
function showDashboard(): void {
  void shell.setLayoutMode("worktrees");
  emit("leave");
}

const list = ref<{ focus: () => void } | null>(null);
const filterField = ref<{ $el: HTMLElement } | null>(null);

/* The list takes the focus (its selected row, else its first); with no row, the filter. */
function focusFirst(): void {
  const before = document.activeElement;
  list.value?.focus();
  if (document.activeElement === before) {
    filterField.value?.$el.querySelector("input")?.focus();
  }
}

/* Opened or shown from the rail or ⌘B, the panel takes the focus, unless an overlay holds it. */
onMounted(() => {
  if (!shell.takeSidebarFocus() || isOverlayTarget(document.activeElement)) return;
  void nextTick(focusFirst);
});

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented || isOverlayTarget(event.target)) return;
  event.preventDefault();
  emit("leave");
}
</script>

<template>
  <aside
    id="sidebar-panel"
    class="sidebar-panel relative flex shrink-0 flex-col border-r border-line bg-app"
    :style="{ width: `${shell.paneSizes.sidebar}px` }"
    aria-labelledby="sidebar-panel-title"
    data-testid="sidebar-panel"
    data-sidebar-panel
    :data-panel="props.id"
    @keydown="onKeydown"
  >
    <div class="flex h-bar-top shrink-0 items-center gap-2 pr-2 pl-3">
      <h2
        id="sidebar-panel-title"
        class="text-md font-medium text-fg"
        data-testid="sidebar-panel-title"
      >
        {{ title }}
      </h2>
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
        :disabled="!repoReady"
        data-testid="sidebar-dashboard"
        @click="showDashboard"
      />
    </div>
    <div class="shrink-0 p-2">
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
      <RepoList v-else-if="props.id === 'repos'" ref="list" :rows="rows.repos" />
      <WorktreeList v-else-if="props.id === 'worktrees'" ref="list" :rows="rows.worktrees" />
      <BranchList
        v-else-if="refKind"
        ref="list"
        :rows="rows[refKind]"
        :kind="refKind"
        :label="title"
        @action="actions.run"
      />
    </div>
    <div class="absolute inset-y-0 -right-px">
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
