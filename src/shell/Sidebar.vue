<script setup lang="ts">
// The 240px sidebar: one filter, then one column of sections that scrolls under their sticky
// headers. In order: the project's repositories (while it holds more than one), the local
// branches, the remote branches, the tags (each while there is one) and the worktrees. A section
// folds from its header (`useSectionFolds`); j/k at a list's end go on into the next open section
// that has a row. A rail icon reveals its section. The branch rows' actions run through
// `useBranchActions`, shared with the graph's ref badges.

import { ArrowDownAZ, ClockArrowDown, LayoutList, Search } from "@lucide/vue";
import { computed, nextTick, onUnmounted, provide, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { useBranchActions } from "@/branches/useBranchActions";
import IconButton from "@/components/IconButton.vue";
import Input from "@/components/Input.vue";
import { useRepoStore } from "@/stores/repo";
import { useSettingsStore, type SidebarSectionId } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";

import BranchList from "./BranchList.vue";
import RepoList from "./RepoList.vue";
import SidebarSection from "./SidebarSection.vue";
import { branchSelectionKey, useBranchSelection } from "./useBranchSelection";
import { useSectionFolds } from "./useSectionFolds";
import { useSidebarSections } from "./useSidebarSections";
import WorktreeList from "./WorktreeList.vue";

const { t, n } = useI18n();
const shell = useShellStore();
const settings = useSettingsStore();
const repo = useRepoStore();
const actions = useBranchActions();

/* One branch selection for the three ref lists: a move from one into the next scopes once. */
const branchSelection = useBranchSelection();
provide(branchSelectionKey, branchSelection);
onUnmounted(branchSelection.dispose);

/* The worktrees are read once the repository is ready, so a folded Worktrees section counts them. */
watch(
  () => repo.state.kind,
  (kind) => {
    if (kind === "ready") void repo.loadWorktrees();
  },
  { immediate: true },
);

const filter = ref("");
const filtering = computed(() => filter.value.trim() !== "");
const { rows, totals, shown } = useSidebarSections(filter);
const { isFolded, setFolded } = useSectionFolds(filtering, (id) => rows.value[id].length);

const titles: Record<SidebarSectionId, string> = {
  repos: "sidebar.repositories",
  local: "sidebar.branches",
  remote: "sidebar.remoteBranches",
  tags: "sidebar.tags",
  worktrees: "sidebar.worktrees",
};

/** Whether a section's rows are being read: it shows skeleton rows and no count meanwhile. */
function reading(id: SidebarSectionId): boolean {
  if (id === "repos") return false;
  if (repo.state.kind === "opening") return true;
  if (repo.state.kind !== "ready") return false;
  return id === "worktrees" ? !repo.worktreesLoaded : !repo.refsLoaded;
}

const worktreesFailed = computed(() => repo.state.kind === "ready" && repo.worktreesError !== null);

/** "12", or "2 of 12" while the filter narrows the section; none while it is read or failed. */
function countOf(id: SidebarSectionId): string {
  if (reading(id) || (id === "worktrees" && worktreesFailed.value)) return "";
  const total = totals.value[id];
  return filtering.value
    ? t("sidebar.countOf", { n: n(rows.value[id].length), m: n(total) })
    : n(total);
}

const column = ref<HTMLElement | null>(null);
const sectionElement = (id: SidebarSectionId) =>
  column.value?.querySelector<HTMLElement>(`[data-section="${id}"]`) ?? null;
const headerOf = (section: HTMLElement | null) =>
  section?.querySelector<HTMLElement>('[data-testid="section-header"]') ?? null;

/** A fold takes the section's rows away: the focus one of them held goes to the header. */
function toggle(id: SidebarSectionId): void {
  const folding = !isFolded(id);
  const section = sectionElement(id);
  if (folding && section?.contains(document.activeElement)) headerOf(section)?.focus();
  setFolded(id, folding);
}

/* The branch order toggle names, and shows, the order it switches to. */
const byRecent = computed(() => settings.values.branchSort === "recent");
function toggleBranchSort(): void {
  void settings.update("branchSort", byRecent.value ? "name" : "recent");
}

/* The worktrees dashboard, from the Worktrees header; it shows an open repository's. */
const repoReady = computed(() => repo.state.kind === "ready");
const dashboardShown = computed(() => repoReady.value && shell.layoutMode === "worktrees");
function toggleDashboard(): void {
  void shell.setLayoutMode(dashboardShown.value ? "graph" : "worktrees");
}

interface SectionList {
  focus: () => void;
  selectEdge: (edge: "first" | "last") => boolean;
}
const lists = new Map<SidebarSectionId, SectionList>();
function listRef(id: SidebarSectionId) {
  return (instance: unknown) => {
    if (instance) lists.set(id, instance as SectionList);
    else lists.delete(id);
  };
}

/** A move past a list's end: the first open section after it (or before it) that has a row takes it. */
function enterNext(from: SidebarSectionId, step: 1 | -1): void {
  const order = shown.value;
  for (let at = order.indexOf(from) + step; at >= 0 && at < order.length; at += step) {
    const id = order[at];
    if (!id || isFolded(id)) continue;
    if (lists.get(id)?.selectEdge(step === 1 ? "first" : "last")) return;
  }
}

/**
 * Opens a section, scrolls it to the column's top and focuses its list's tab stop, or its header
 * when it has no row to take the focus (a repository that failed to open lists no branch).
 */
async function reveal(id: SidebarSectionId): Promise<void> {
  if (!shown.value.includes(id)) return;
  if (filtering.value) filter.value = "";
  if (isFolded(id)) setFolded(id, false);
  await nextTick();
  const section = sectionElement(id);
  section?.scrollIntoView?.({ block: "start" });
  lists.get(id)?.focus();
  if (section && !section.contains(document.activeElement)) headerOf(section)?.focus();
}

watch(
  () => shell.sidebarReveal,
  (request) => {
    if (!request) return;
    shell.sidebarReveal = null;
    void reveal(request.id);
  },
  { immediate: true },
);
</script>

<template>
  <aside
    class="flex shrink-0 flex-col border-r border-line"
    :style="{ width: `${shell.paneSizes.sidebar}px` }"
    data-testid="sidebar"
  >
    <div class="flex items-center px-2 py-2">
      <Input
        v-model="filter"
        :placeholder="t('sidebar.filter')"
        :icon="Search"
        data-testid="sidebar-filter"
      />
    </div>
    <div
      ref="column"
      class="sidebar-column min-h-0 flex-1 overflow-y-auto pb-2"
      data-testid="sidebar-column"
    >
      <SidebarSection
        v-for="id in shown"
        :key="id"
        :data-section="id"
        :heading="t(titles[id])"
        :count="countOf(id)"
        :folded="isFolded(id)"
        :alert="id === 'worktrees' && worktreesFailed ? t('sidebar.worktreesUnlisted') : ''"
        @toggle="toggle(id)"
      >
        <template v-if="id === 'local'" #actions>
          <IconButton
            :icon="byRecent ? ArrowDownAZ : ClockArrowDown"
            :label="byRecent ? t('sidebar.sortByName') : t('sidebar.sortByRecent')"
            data-testid="branch-sort"
            @click="toggleBranchSort"
          />
        </template>
        <template v-else-if="id === 'worktrees'" #actions>
          <IconButton
            :icon="LayoutList"
            :label="t('palette.commandsById.show-worktrees')"
            :pressed="dashboardShown"
            :disabled="!repoReady"
            data-testid="sidebar-dashboard"
            @click="toggleDashboard"
          />
        </template>
        <p
          v-if="filtering && rows[id].length === 0"
          class="px-3 py-2 text-md text-fg-secondary"
          data-testid="section-no-matches"
        >
          {{ t("sidebar.noMatches") }}
        </p>
        <RepoList
          v-else-if="id === 'repos'"
          :ref="listRef('repos')"
          :rows="rows.repos"
          @edge="(step) => enterNext('repos', step)"
        />
        <WorktreeList
          v-else-if="id === 'worktrees'"
          :ref="listRef('worktrees')"
          :rows="rows.worktrees"
          @edge="(step) => enterNext('worktrees', step)"
        />
        <BranchList
          v-else-if="id === 'local' || id === 'remote' || id === 'tags'"
          :ref="listRef(id)"
          :rows="rows[id]"
          :kind="id"
          :label="t(titles[id])"
          @action="actions.run"
          @edge="(step) => enterNext(id, step)"
        />
      </SidebarSection>
    </div>
  </aside>
</template>

<style scoped>
/* A row j/k scrolls into view clears its section's sticky header. */
.sidebar-column :deep([role="option"]) {
  scroll-margin-top: var(--row-list);
}

/* The rows' ring goes inside: the column clips their sides and a sticky header their top. */
.sidebar-column :deep([role="option"]:focus-visible) {
  outline-offset: -2px;
}
</style>
