<script setup lang="ts">
// The column header of the home table: Name, Branch and Last commit sort the All section on
// click; the active column shows its direction.

import { ArrowDown, ArrowUp } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import { useIndexStore, type SortColumn } from "@/stores/index";

const { t } = useI18n();
const index = useIndexStore();

const columns: { id: string; label: string; sort?: SortColumn }[] = [
  { id: "name", label: "home.columns.name", sort: "name" },
  { id: "branch", label: "home.columns.branch", sort: "branch" },
  { id: "aheadBehind", label: "home.columns.aheadBehind" },
  { id: "lastCommit", label: "home.columns.lastCommit", sort: "lastCommit" },
  { id: "path", label: "home.columns.path" },
];

function ariaSort(column: SortColumn): "ascending" | "descending" | "none" {
  if (index.sort.column !== column) return "none";
  return index.sort.direction === "asc" ? "ascending" : "descending";
}

function sortBy(column: SortColumn | undefined): void {
  if (column) index.setSort(column);
}
</script>

<template>
  <div
    class="repo-table-columns grid h-control shrink-0 items-center gap-4 border-b border-l-2 border-line border-l-transparent px-3 text-sm whitespace-nowrap text-fg-muted"
    data-testid="repo-table-columns"
  >
    <template v-for="column in columns" :key="column.id">
      <button
        v-if="column.sort"
        type="button"
        class="flex items-center gap-1 rounded-sm text-left hover:text-fg"
        :class="{ 'text-fg': index.sort.column === column.sort }"
        :aria-sort="ariaSort(column.sort)"
        :title="t('home.sortBy', { column: t(column.label) })"
        :data-testid="`sort-${column.id}`"
        @click="sortBy(column.sort)"
      >
        {{ t(column.label) }}
        <component
          :is="index.sort.direction === 'asc' ? ArrowUp : ArrowDown"
          v-if="index.sort.column === column.sort"
          :size="12"
          :stroke-width="1.5"
          aria-hidden="true"
        />
      </button>
      <span v-else>{{ t(column.label) }}</span>
    </template>
  </div>
</template>

<style scoped>
/* The same widths as the rows (see RepoTable.vue): name 200, branch 180, ahead 84, commit 80. */
.repo-table-columns {
  grid-template-columns: 200px 180px 84px 80px minmax(0, 1fr);
}
</style>
