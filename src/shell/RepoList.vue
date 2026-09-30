<script setup lang="ts">
// The Repos tab: the open project's repositories and worktrees in its order, each worktree
// under its repository when both are members, filtered by the sidebar filter; the one the
// project shows is selected, a missing one is flagged, and ↵ or a click shows the focused one
// instead. A repository the project shows without holding it (opening, or gone from the
// project meanwhile) is listed first, so the tab never hides the current one.

import { FolderGit2, ListTree } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import ListRow from "@/components/ListRow.vue";
import { matchesQuery } from "@/palette/usePalette";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import { useProjectsStore } from "@/stores/projects";
import { useRepoStore } from "@/stores/repo";

import { baseName, sameFolder } from "./format";

const props = defineProps<{ filter: string }>();

const { t } = useI18n();
const repo = useRepoStore();
const projects = useProjectsStore();
const listbox = ref<HTMLElement | null>(null);

interface RepoListRow {
  path: string;
  name: string;
  branch: string;
  worktree: boolean;
  nested: boolean;
  missing: boolean;
}

/** The repository the project shows: the open one, or the one opening or failing. */
const currentPath = computed(() => projects.shownPath);

const rows = computed<RepoListRow[]>(() => {
  const filtering = props.filter.trim() !== "";
  const failing = repo.state.kind === "error" ? repo.state.path : null;
  const list: RepoListRow[] = projects.activeMembers.map((member) => {
    const summary = member.entry?.summary;
    return {
      path: member.path,
      name: member.name,
      branch: summary?.detached ? t("statusBar.detached") : (summary?.currentBranch ?? ""),
      worktree: member.entry?.kind === "worktree",
      nested: member.nested && !filtering,
      missing: member.missing || (failing !== null && sameFolder(failing, member.path)),
    };
  });
  const current = currentPath.value;
  if (current !== null && !list.some((row) => sameFolder(row.path, current))) {
    list.unshift({
      path: current,
      name: baseName(current),
      branch: repo.repo?.currentBranch ?? "",
      worktree: repo.repo?.isLinkedWorktree ?? false,
      nested: false,
      missing: repo.state.kind === "error",
    });
  }
  return list.filter((row) => matchesQuery(`${row.name} ${row.branch}`, props.filter));
});
const rowCount = computed(() => rows.value.length);

/* The selection follows the repository the project shows, then the user's moves. */
const selectedPath = ref<string | null>(currentPath.value);
watch(currentPath, (path) => {
  selectedPath.value = path;
});
const selectedRow = computed({
  get: () =>
    rows.value.findIndex(
      (row) => selectedPath.value !== null && sameFolder(row.path, selectedPath.value),
    ),
  set: (position: number) => {
    selectedPath.value = rows.value[position]?.path ?? null;
  },
});
const tabStopRow = computed(() => Math.max(0, selectedRow.value));

const navigation = useListNavigation({
  count: rowCount,
  selected: selectedRow,
  rowElement: (position) => listbox.value?.querySelector(`[data-index="${position}"]`),
});

function open(row: RepoListRow): void {
  if (row.missing && !projects.isShown(row.path)) return;
  void projects.show(row.path);
}

defineExpose({ focus: navigation.focus });
</script>

<template>
  <div
    id="sidebar-repos"
    ref="listbox"
    role="listbox"
    :aria-label="t('sidebar.repos')"
    class="min-h-0 flex-1 overflow-y-auto"
    data-testid="repo-list"
    @keydown="navigation.onKeydown"
  >
    <ListRow
      v-for="(row, position) in rows"
      :key="row.path"
      :data-index="position"
      :data-path="row.path"
      :class="{ 'repo-list-nested': row.nested }"
      :name="row.name"
      :icon="row.worktree ? ListTree : FolderGit2"
      :meta="row.missing ? t('sidebar.notFound') : row.branch"
      :missing="row.missing"
      :selected="position === selectedRow"
      :tab-stop="position === tabStopRow"
      @select="
        () => {
          navigation.select(position);
          open(row);
        }
      "
      @activate="open(row)"
    />
    <p v-if="rows.length === 0" class="px-3 py-2 text-md text-fg-secondary">
      {{ props.filter.trim() === "" ? t("sidebar.noRepositories") : t("sidebar.noRepoMatches") }}
    </p>
  </div>
</template>

<style scoped>
/* A worktree hangs under its repository, indented one step past the row padding. */
.repo-list-nested {
  padding-left: var(--space-6);
}
</style>
