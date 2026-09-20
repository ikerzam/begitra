<script setup lang="ts">
// The Repos tab: the indexed repositories, pinned first then by name, each followed by its
// worktrees, filtered by the sidebar filter; the open repository is selected, a missing one is
// flagged, and ↵ opens the focused row through the index store. A repository that is open (or
// failed to open) without being indexed is listed too, so the tab never hides the current one.

import { FolderGit2, ListTree } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import ListRow from "@/components/ListRow.vue";
import type { IndexEntry } from "@/ipc/schemas";
import { matchesQuery } from "@/palette/usePalette";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import { useIndexStore } from "@/stores/index";
import { useRepoStore } from "@/stores/repo";

import { baseName } from "./format";

const props = defineProps<{ filter: string }>();

const { t } = useI18n();
const repo = useRepoStore();
const index = useIndexStore();
const listbox = ref<HTMLElement | null>(null);

interface RepoListRow {
  path: string;
  name: string;
  branch: string;
  worktree: boolean;
  nested: boolean;
  missing: boolean;
}

/** The open repository's root, or the folder being opened or that failed to open. */
const currentPath = computed(() => {
  const state = repo.state;
  if (state.kind === "ready") return repo.repo?.root ?? null;
  if (state.kind === "opening" || state.kind === "error") return state.path;
  return null;
});

function toRow(entry: IndexEntry, nested: boolean): RepoListRow {
  const missing = entry.missing || (repo.state.kind === "error" && repo.state.path === entry.path);
  return {
    path: entry.path,
    name: entry.name,
    branch: entry.summary.detached ? t("statusBar.detached") : (entry.summary.currentBranch ?? ""),
    worktree: entry.kind === "worktree",
    nested,
    missing,
  };
}

const rows = computed<RepoListRow[]>(() => {
  const filtering = props.filter.trim() !== "";
  const listed = new Set<string>();
  const list: RepoListRow[] = [];
  for (const main of index.mains) {
    listed.add(main.path);
    list.push(toRow(main, false));
    for (const worktree of index.worktreesOf(main.path)) {
      listed.add(worktree.path);
      list.push(toRow(worktree, !filtering));
    }
  }
  for (const worktree of index.worktrees) {
    if (listed.has(worktree.path)) continue;
    listed.add(worktree.path);
    list.push(toRow(worktree, false));
  }
  const current = currentPath.value;
  if (current !== null && !listed.has(current)) {
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

/* The selection follows the open repository, then the user's moves. */
const selectedPath = ref<string | null>(currentPath.value);
watch(currentPath, (path) => {
  selectedPath.value = path;
});
const selectedRow = computed({
  get: () => rows.value.findIndex((row) => row.path === selectedPath.value),
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
  void index.open(row.path);
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
      @select="navigation.select(position)"
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
