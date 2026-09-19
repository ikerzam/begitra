<script setup lang="ts">
// The Worktrees tab: the worktrees of the open repository, filtered, with roving focus and
// j/k navigation. Rows show the worktree icon and the branch.

import { ListTree } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import ListRow from "@/components/ListRow.vue";
import { matchesQuery } from "@/palette/usePalette";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import { useRepoStore } from "@/stores/repo";

import { baseName } from "./format";

const props = defineProps<{ filter: string }>();

const { t } = useI18n();
const repo = useRepoStore();
const listbox = ref<HTMLElement | null>(null);

const rows = computed(() =>
  repo.worktrees
    .map((worktree) => ({
      key: worktree.path,
      name: worktree.isMain ? t("sidebar.mainWorktree") : baseName(worktree.path),
      meta: worktree.branch ?? "",
    }))
    .filter((row) => matchesQuery(`${row.name} ${row.meta}`, props.filter)),
);
const rowCount = computed(() => rows.value.length);

/* The selection follows the path, so filtering keeps it; none until the user picks a row. */
const selectedKey = ref<string | null>(null);
const selectedRow = computed({
  get: () => rows.value.findIndex((row) => row.key === selectedKey.value),
  set: (index: number) => {
    selectedKey.value = rows.value[index]?.key ?? null;
  },
});
const tabStopRow = computed(() => Math.max(0, selectedRow.value));

const navigation = useListNavigation({
  count: rowCount,
  selected: selectedRow,
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
      :icon="ListTree"
      :meta="row.meta"
      :selected="index === selectedRow"
      :tab-stop="index === tabStopRow"
      @select="navigation.select(index)"
    />
    <p v-if="rows.length === 0" class="px-3 py-2 text-md text-fg-secondary">
      {{ repo.state.kind === "ready" ? t("sidebar.noWorktrees") : t("sidebar.noRepository") }}
    </p>
  </div>
</template>
