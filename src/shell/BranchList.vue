<script setup lang="ts">
// The Branches tab: local branches, remote branches and tags, filtered, with roving focus and
// j/k navigation. Nothing is selected until the user picks a row; the first row is the tab stop
// until then. Lane colours come from the shared map, so they survive filtering.

import { Tag } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import ListRow from "@/components/ListRow.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import type { Ref as GitRef } from "@/ipc/schemas";
import { matchesQuery } from "@/palette/usePalette";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import { useRepoStore } from "@/stores/repo";

import { branchLanes } from "./branchLanes";

const props = defineProps<{ filter: string }>();

const { t } = useI18n();
const repo = useRepoStore();
const listbox = ref<HTMLElement | null>(null);

interface BranchRow {
  ref: GitRef;
  lane: number;
}

interface BranchGroup {
  id: "local" | "remote" | "tags";
  label: string;
  rows: BranchRow[];
}

const groups = computed<BranchGroup[]>(() => {
  const lanes = branchLanes(repo.refs);
  const matching = repo.refs.filter((r) => matchesQuery(r.name, props.filter));
  const pick = (kind: GitRef["kind"]) =>
    matching
      .filter((r) => r.kind === kind)
      .map((r) => ({ ref: r, lane: lanes.get(r.fullName) ?? 0 }));
  const all: BranchGroup[] = [
    { id: "local", label: t("sidebar.local"), rows: pick("local-branch") },
    { id: "remote", label: t("sidebar.remote"), rows: pick("remote-branch") },
    { id: "tags", label: t("sidebar.tags"), rows: pick("tag") },
  ];
  return all.filter((group) => group.rows.length > 0);
});

const flatRows = computed(() => groups.value.flatMap((group) => group.rows));
const rowCount = computed(() => flatRows.value.length);

/* The selection follows the ref, so filtering keeps it; none until the user picks a row. */
const selectedName = ref<string | null>(null);
const selectedRow = computed({
  get: () => flatRows.value.findIndex((row) => row.ref.fullName === selectedName.value),
  set: (index: number) => {
    selectedName.value = flatRows.value[index]?.ref.fullName ?? null;
  },
});
const tabStopRow = computed(() => Math.max(0, selectedRow.value));

const navigation = useListNavigation({
  count: rowCount,
  selected: selectedRow,
  rowElement: (index) => listbox.value?.querySelector(`[data-index="${index}"]`),
});

function rowIndex(groupIndex: number, index: number): number {
  let offset = 0;
  for (let i = 0; i < groupIndex; i += 1) offset += groups.value[i]?.rows.length ?? 0;
  return offset + index;
}

defineExpose({ focus: navigation.focus });
</script>

<template>
  <div
    id="sidebar-branches"
    ref="listbox"
    role="listbox"
    :aria-label="t('sidebar.branches')"
    class="min-h-0 flex-1 overflow-y-auto pb-2"
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
        :tab-stop="rowIndex(groupIndex, index) === tabStopRow"
        @select="navigation.select(rowIndex(groupIndex, index))"
      />
    </template>
    <template v-if="groups.length === 0 && repo.state.kind === 'ready' && !repo.refsLoaded">
      <SkeletonRow v-for="n in 6" :key="n" :index="n" height="list" />
    </template>
    <p v-else-if="groups.length === 0" class="px-3 py-4 text-md text-fg-secondary">
      {{ repo.state.kind === "ready" ? t("sidebar.noBranches") : t("sidebar.noRepository") }}
    </p>
  </div>
</template>
