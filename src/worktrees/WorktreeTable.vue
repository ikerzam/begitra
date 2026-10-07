<script setup lang="ts">
// The worktrees table: the column headers, one `WorktreeRow` per worktree (the main one first),
// skeleton rows while the list loads and the footer sentence. A grid with roving focus: j/k and
// the arrows move, ↵ opens the worktree as the context, the menu key opens the row's menu.

import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import MotionRows from "@/components/MotionRows.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import WorktreeRow from "@/components/WorktreeRow.vue";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import ColumnResizer from "@/shell/ColumnResizer.vue";
import { relativeDate } from "@/shell/format";
import { useNow } from "@/shell/useNow";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import { columnLimits, useShellStore } from "@/stores/shell";
import type { WorktreeRow as Row } from "@/stores/worktrees";

const props = withDefaults(
  defineProps<{
    rows: Row[];
    /** Lane of each row's branch, by path; 0 when it has none. */
    lanes: Record<string, number>;
    selectedPath: string | null;
    loading?: boolean;
    skeletonRows?: number;
    /** The rows whose removal runs. */
    removing?: string[];
  }>(),
  { loading: false, skeletonRows: 4, removing: () => [] },
);
const emit = defineEmits<{
  select: [path: string];
  activate: [path: string];
  compare: [path: string];
  terminal: [path: string];
  editor: [path: string];
  remove: [path: string];
  menu: [path: string, x: number, y: number];
}>();

const { t } = useI18n();
const now = useNow();
const format = useDiscoveryFormat();
const grid = ref<HTMLElement | null>(null);
const shell = useShellStore();

/* The resizable columns (the last commit takes the rest) and their widths, which the header
   and every row read. */
const resizable = [
  { width: "path", label: "worktrees.columns.path" },
  { width: "branch", label: "worktrees.columns.branch" },
  { width: "state", label: "worktrees.columns.state" },
  { width: "ahead", label: "worktrees.columns.aheadBehind" },
] as const;
const columnStyle = computed(() => {
  const widths = shell.columnWidths.worktrees;
  return {
    "--worktree-path-w": `${widths.path}px`,
    "--worktree-branch-w": `${widths.branch}px`,
    "--worktree-state-w": `${widths.state}px`,
    "--worktree-ahead-w": `${widths.ahead}px`,
  };
});

const rowCount = computed(() => props.rows.length);
const selectedIndex = computed({
  get: () => props.rows.findIndex((row) => row.path === props.selectedPath),
  set: (index: number) => {
    const row = props.rows[index];
    if (row) emit("select", row.path);
  },
});
const tabStop = computed(() => Math.max(0, selectedIndex.value));
const showSkeleton = computed(() => props.loading && rowCount.value === 0);

const navigation = useListNavigation({
  count: rowCount,
  selected: selectedIndex,
  onActivate: (index) => {
    const row = props.rows[index];
    if (row) emit("activate", row.path);
  },
  rowElement: (index) => grid.value?.querySelector(`[data-index="${index}"]`),
});

function date(time: number | null): string {
  if (time === null) return "";
  const rel = relativeDate(time, now.value);
  return rel.unit === "now" ? t("date.now") : t(`date.${rel.unit}`, { n: rel.n });
}

/** Focuses the selected row, or the first one, once the rows are rendered. */
async function focus(): Promise<void> {
  await nextTick();
  navigation.focus();
}

/**
 * Whether a sidebar panel holds the focus (its filter or its rows): the rows arriving behind it
 * leave that focus where it is, since taking it would close the panel.
 */
function sidebarPanelFocused(): boolean {
  const active = document.activeElement;
  return active instanceof Element && active.closest('[data-testid="sidebar-panel"]') !== null;
}

// A selected row that disappeared (removed, pruned) hands the focus to the first row; the
// first rows take the focus when they arrive after the dashboard opened, unless a sidebar panel
// holds it.
watch(rowCount, (count, previous) => {
  if (count < previous && selectedIndex.value < 0 && count > 0) void focus();
  if (previous === 0 && count > 0 && !sidebarPanelFocused()) void focus();
});

defineExpose({ focus, sidebarPanelFocused });
</script>

<template>
  <div class="flex min-h-0 flex-col" :style="columnStyle" data-testid="worktree-table">
    <div
      role="grid"
      :aria-label="t('worktrees.title')"
      :aria-busy="props.loading ? 'true' : undefined"
      class="worktree-grid flex min-h-0 flex-col"
      @keydown="navigation.onKeydown"
    >
      <div
        role="row"
        class="worktree-table-header grid h-control shrink-0 items-center gap-4 border-b border-l-2 border-line border-l-transparent px-3 text-sm text-fg-muted whitespace-nowrap"
      >
        <span
          v-for="column in resizable"
          :key="column.width"
          role="columnheader"
          class="relative flex min-w-0 items-center"
        >
          <span class="truncate">{{ t(column.label) }}</span>
          <ColumnResizer
            :size="shell.columnWidths.worktrees[column.width]"
            :min="columnLimits.min"
            :max="columnLimits.max"
            :label="t('layout.resizeColumn', { column: t(column.label) })"
            @resize="(px) => void shell.setColumnWidth('worktrees', column.width, px)"
            @reset="() => void shell.resetColumnWidth('worktrees', column.width)"
          />
        </span>
        <span role="columnheader">{{ t("worktrees.columns.lastCommit") }}</span>
        <span role="columnheader" class="sr-only">{{ t("worktrees.columns.actions") }}</span>
      </div>
      <div ref="grid" role="rowgroup" class="min-h-0 overflow-y-auto" data-testid="worktree-rows">
        <template v-if="showSkeleton">
          <SkeletonRow v-for="i in props.skeletonRows" :key="i" :index="i - 1" height="list" />
        </template>
        <MotionRows list="worktrees" :count="props.rows.length" role="none">
          <WorktreeRow
            v-for="(row, index) in props.rows"
            :key="row.path"
            :data-index="index"
            :path="format.displayPath(row.path)"
            :branch="row.branch ?? (row.head ? row.head.slice(0, 7) : '')"
            :lane="props.lanes[row.path] ?? 0"
            :dirty="row.dirty === true"
            :locked="row.locked"
            :lock-reason="row.lockReason ?? ''"
            :missing="row.prunable"
            :main="row.isMain"
            :ahead="row.ahead"
            :behind="row.behind"
            :last-commit="row.lastSubject ?? ''"
            :last-commit-date="date(row.lastCommitAt)"
            :selected="index === selectedIndex"
            :tab-stop="index === tabStop"
            :removing="props.removing.includes(row.path)"
            @select="navigation.select(index)"
            @activate="emit('activate', row.path)"
            @compare="emit('compare', row.path)"
            @terminal="emit('terminal', row.path)"
            @editor="emit('editor', row.path)"
            @remove="emit('remove', row.path)"
            @menu="(x, y) => emit('menu', row.path, x, y)"
          />
        </MotionRows>
      </div>
    </div>
    <p class="shrink-0 px-3 py-3 text-sm text-fg-muted" data-testid="worktree-footer">
      {{ t("worktrees.footer") }}
    </p>
  </div>
</template>

<style scoped>
/* The header and the rows read the widths WorktreeTable sets from the settings (the ahead/behind
   column defaults to 84px here, where the row's own default is 56). */
.worktree-table-header {
  grid-template-columns:
    var(--worktree-path-w, 200px) var(--worktree-branch-w, 200px) var(--worktree-state-w, 96px)
    var(--worktree-ahead-w, 84px) minmax(0, 1fr) auto;
}
</style>
