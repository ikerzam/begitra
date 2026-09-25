<script setup lang="ts">
// The column header of the home table: Name, Branch and Last commit sort the All section on
// click; the active column shows its direction. Every column but the path resizes from its
// right edge (the widths are the settings', which the rows read too).

import { ArrowDown, ArrowUp } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import ColumnResizer from "@/shell/ColumnResizer.vue";
import { useIndexStore, type SortColumn } from "@/stores/index";
import { columnLimits, useShellStore } from "@/stores/shell";

const { t } = useI18n();
const index = useIndexStore();
const shell = useShellStore();

type Width = "name" | "branch" | "ahead" | "commit";

const columns: { id: string; label: string; sort?: SortColumn; width?: Width }[] = [
  { id: "name", label: "home.columns.name", sort: "name", width: "name" },
  { id: "branch", label: "home.columns.branch", sort: "branch", width: "branch" },
  { id: "aheadBehind", label: "home.columns.aheadBehind", width: "ahead" },
  { id: "lastCommit", label: "home.columns.lastCommit", sort: "lastCommit", width: "commit" },
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
    <div v-for="column in columns" :key="column.id" class="relative flex min-w-0 items-center">
      <button
        v-if="column.sort"
        type="button"
        class="flex items-center gap-1 rounded-sm text-left hover:text-fg"
        :class="{ 'text-fg': index.sort.column === column.sort }"
        :aria-sort="ariaSort(column.sort)"
        :data-tooltip="t('home.sortBy', { column: t(column.label) })"
        :aria-description="t('home.sortBy', { column: t(column.label) })"
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
      <ColumnResizer
        v-if="column.width"
        :size="shell.columnWidths.home[column.width]"
        :min="columnLimits.min"
        :max="columnLimits.max"
        :label="t('layout.resizeColumn', { column: t(column.label) })"
        @resize="(px) => column.width && void shell.setColumnWidth('home', column.width, px)"
        @reset="() => column.width && void shell.resetColumnWidth('home', column.width)"
      />
    </div>
  </div>
</template>

<style scoped>
/* The rows' widths, which RepoTable sets from the settings (200, 180, 84 and 80 by default). */
.repo-table-columns {
  grid-template-columns:
    var(--repo-name-w) var(--repo-branch-w) var(--repo-ahead-w) var(--repo-commit-w)
    minmax(0, 1fr);
}
</style>
