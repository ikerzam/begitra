<script setup lang="ts">
import { CircleAlert, FolderGit2, ListTree, Search, Tag } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Input from "@/components/Input.vue";
import ListRow from "@/components/ListRow.vue";
import TabsItem from "@/components/TabsItem.vue";
import type { Ref as GitRef } from "@/ipc/schemas";
import { matchesQuery } from "@/palette/usePalette";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import { useRepoStore } from "@/stores/repo";
import { useShellStore, type SidebarTab } from "@/stores/shell";

import { baseName } from "./format";

const { t } = useI18n();
const shell = useShellStore();
const repo = useRepoStore();

const tabs: { id: SidebarTab; label: string }[] = [
  { id: "repos", label: "sidebar.repos" },
  { id: "branches", label: "sidebar.branches" },
  { id: "worktrees", label: "sidebar.worktrees" },
];

const filter = ref("");
const listbox = ref<HTMLElement | null>(null);

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

interface BranchRow {
  ref: GitRef;
  lane: number;
}

interface BranchGroup {
  id: "local" | "remote" | "tags";
  label: string;
  rows: BranchRow[];
}

/** Local branches, remote branches and tags, filtered, each with a lane colour by position. */
const groups = computed<BranchGroup[]>(() => {
  const matching = repo.refs.filter((r) => matchesQuery(r.name, filter.value));
  const pick = (kind: GitRef["kind"]) =>
    matching.filter((r) => r.kind === kind).map((r, i) => ({ ref: r, lane: (i % 8) + 1 }));
  const all: BranchGroup[] = [
    { id: "local", label: t("sidebar.local"), rows: pick("local-branch") },
    { id: "remote", label: t("sidebar.remote"), rows: pick("remote-branch") },
    { id: "tags", label: t("sidebar.tags"), rows: pick("tag").map((r) => ({ ...r, lane: 0 })) },
  ];
  return all.filter((group) => group.rows.length > 0);
});

const flatRows = computed(() => groups.value.flatMap((group) => group.rows));
const rowCount = computed(() => flatRows.value.length);
const selectedRow = ref(-1);

watch(
  [flatRows, () => repo.currentBranch],
  () => {
    const current = flatRows.value.findIndex((row) => row.ref.isCurrent);
    if (selectedRow.value < 0 || selectedRow.value >= flatRows.value.length) {
      selectedRow.value = current;
    }
  },
  { immediate: true },
);

const navigation = useListNavigation({
  count: rowCount,
  selected: selectedRow,
  rowElement: (index) => listbox.value?.querySelector(`[data-index="${index}"]`),
});

const worktreeRows = computed(() =>
  repo.worktrees
    .map((worktree) => ({
      key: worktree.path,
      name: worktree.isMain ? t("sidebar.mainWorktree") : baseName(worktree.path),
      meta: worktree.branch ?? "",
    }))
    .filter((row) => matchesQuery(`${row.name} ${row.meta}`, filter.value)),
);

const repoName = computed(() => {
  const state = repo.state;
  if (state.kind === "ready") return baseName(repo.repo?.root ?? "");
  if (state.kind === "opening" || state.kind === "error") return baseName(state.path);
  return "";
});

watch(
  () => [shell.sidebarTab, repo.state.kind] as const,
  ([tab, kind]) => {
    if (tab === "worktrees" && kind === "ready") void repo.loadWorktrees();
  },
  { immediate: true },
);

function rowIndex(groupIndex: number, index: number): number {
  let offset = 0;
  for (let i = 0; i < groupIndex; i += 1) offset += groups.value[i]?.rows.length ?? 0;
  return offset + index;
}
</script>

<template>
  <aside class="flex w-sidebar shrink-0 flex-col border-r border-line" data-testid="sidebar">
    <div
      role="tablist"
      class="flex h-panel-header shrink-0 items-center gap-4 border-b border-line px-3"
    >
      <TabsItem
        v-for="tab in tabs"
        :key="tab.id"
        :label="t(tab.label)"
        :selected="shell.sidebarTab === tab.id"
        :controls="`sidebar-${tab.id}`"
        :data-testid="`tab-${tab.id}`"
        @select="shell.setSidebarTab(tab.id)"
      />
    </div>
    <div class="px-3 py-2">
      <Input v-model="filter" :placeholder="filterPlaceholder" :icon="Search" />
    </div>

    <div
      v-if="shell.sidebarTab === 'branches'"
      id="sidebar-branches"
      ref="listbox"
      role="listbox"
      tabindex="0"
      class="min-h-0 flex-1 overflow-y-auto pb-2 outline-none"
      data-testid="branch-list"
      @keydown="navigation.onKeydown"
    >
      <template v-for="(group, groupIndex) in groups" :key="group.id">
        <p class="px-3 pt-3 pb-1 text-sm text-fg-muted">{{ group.label }}</p>
        <ListRow
          v-for="(row, index) in group.rows"
          :key="row.ref.fullName"
          :data-index="rowIndex(groupIndex, index)"
          :name="row.ref.name"
          :lane="row.lane"
          :icon="group.id === 'tags' ? Tag : undefined"
          :ahead="row.ref.upstream ? (row.ref.ahead ?? undefined) : undefined"
          :behind="row.ref.upstream ? (row.ref.behind ?? undefined) : undefined"
          :selected="rowIndex(groupIndex, index) === selectedRow"
          @select="navigation.select(rowIndex(groupIndex, index))"
        />
      </template>
      <p v-if="groups.length === 0" class="px-3 py-4 text-md text-fg-secondary">
        {{ repo.state.kind === "ready" ? t("sidebar.noBranches") : t("sidebar.noRepository") }}
      </p>
    </div>

    <div
      v-else-if="shell.sidebarTab === 'repos'"
      id="sidebar-repos"
      role="listbox"
      class="min-h-0 flex-1 overflow-y-auto py-2"
      data-testid="repo-list"
    >
      <ListRow
        v-if="repo.state.kind === 'ready' || repo.state.kind === 'opening'"
        :name="repoName"
        :icon="FolderGit2"
        :meta="repo.repo?.currentBranch ?? ''"
        selected
      />
      <div
        v-else-if="repo.state.kind === 'error'"
        role="option"
        aria-selected="true"
        class="flex h-row-list items-center gap-2 border-l-2 border-accent bg-selected px-3 text-md"
        data-testid="repo-row-error"
      >
        <CircleAlert :size="16" :stroke-width="1.5" aria-hidden="true" class="text-danger" />
        <span class="flex-1 truncate text-fg">{{ repoName }}</span>
        <span class="text-sm text-danger">{{ t("sidebar.notFound") }}</span>
      </div>
      <p v-else class="px-3 py-2 text-md text-fg-secondary">{{ t("sidebar.noRepository") }}</p>
    </div>

    <div
      v-else
      id="sidebar-worktrees"
      role="listbox"
      class="min-h-0 flex-1 overflow-y-auto py-2"
      data-testid="worktree-list"
    >
      <ListRow
        v-for="row in worktreeRows"
        :key="row.key"
        :name="row.name"
        :icon="ListTree"
        :meta="row.meta"
      />
      <p v-if="worktreeRows.length === 0" class="px-3 py-2 text-md text-fg-secondary">
        {{ repo.state.kind === "ready" ? t("sidebar.noWorktrees") : t("sidebar.noRepository") }}
      </p>
    </div>
  </aside>
</template>
