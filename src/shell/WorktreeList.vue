<script setup lang="ts">
// The Worktrees tab: the worktrees of the open repository as their folder name with the
// branch's lane dot and the tree icon, filtered, with roving focus and
// j/k navigation. Selecting a row selects it in the dashboard; ↵ opens it as the context.

import { ListTree } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import ListRow from "@/components/ListRow.vue";
import { matchesQuery } from "@/palette/usePalette";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import { useRepoStore } from "@/stores/repo";
import { useWorktreesStore } from "@/stores/worktrees";

import { branchLanes } from "./branchLanes";
import { baseName } from "./format";

const props = defineProps<{ filter: string }>();

const { t } = useI18n();
const repo = useRepoStore();
const worktrees = useWorktreesStore();
const listbox = ref<HTMLElement | null>(null);

const rows = computed(() => {
  const lanes = branchLanes(repo.refs);
  return repo.worktrees
    .map((worktree) => ({
      key: worktree.path,
      name: baseName(worktree.path),
      branch: worktree.branch ?? "",
      missing: worktree.prunable,
      lane: worktree.branch
        ? (lanes.get(worktree.branch) ?? lanes.get(`refs/heads/${worktree.branch}`) ?? 0)
        : 0,
    }))
    .filter((row) => matchesQuery(`${row.name} ${row.branch}`, props.filter));
});
const rowCount = computed(() => rows.value.length);

/* The selection is the dashboard's, so both sides agree; filtering keeps it. */
const selectedRow = computed({
  get: () => rows.value.findIndex((row) => row.key === worktrees.selectedPath),
  set: (index: number) => {
    worktrees.select(rows.value[index]?.key ?? null);
  },
});
const tabStopRow = computed(() => Math.max(0, selectedRow.value));

const navigation = useListNavigation({
  count: rowCount,
  selected: selectedRow,
  onActivate: (index) => {
    const row = rows.value[index];
    if (row) void worktrees.openAsContext(row.key);
  },
  rowElement: (index) => listbox.value?.querySelector(`[data-index="${index}"]`),
});

// The list is fetched when the tab opens on a ready repository.
watch(
  () => repo.state.kind,
  (kind) => {
    if (kind === "ready") void repo.loadWorktrees();
  },
  { immediate: true },
);

defineExpose({ focus: navigation.focus });
</script>

<template>
  <div
    id="sidebar-worktrees"
    ref="listbox"
    role="listbox"
    :aria-label="t('sidebar.worktrees')"
    class="min-h-0 flex-1 overflow-y-auto"
    data-testid="worktree-list"
    @keydown="navigation.onKeydown"
  >
    <ListRow
      v-for="(row, index) in rows"
      :key="row.key"
      :data-index="index"
      :name="row.name"
      :lane="row.lane"
      :icon="ListTree"
      icon-beside
      :missing="row.missing"
      :meta="row.missing ? t('sidebar.notFound') : ''"
      :selected="index === selectedRow"
      :tab-stop="index === tabStopRow"
      @select="navigation.select(index)"
      @activate="() => void worktrees.openAsContext(row.key)"
    />
    <p v-if="rows.length === 0" class="px-3 py-2 text-md text-fg-secondary">
      {{ repo.state.kind === "ready" ? t("sidebar.noWorktrees") : t("sidebar.noRepository") }}
    </p>
  </div>
</template>
