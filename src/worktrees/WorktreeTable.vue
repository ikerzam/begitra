<script setup lang="ts">
// The worktrees table: the column headers, one `WorktreeRow` per worktree
// (the main one first), skeleton rows while the list loads and the
// footer sentence. A grid with roving focus: j/k and the arrows move, ↵ opens the worktree
// as the context, the menu key opens the row's context menu.

import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import SkeletonRow from "@/components/SkeletonRow.vue";
import WorktreeRow from "@/components/WorktreeRow.vue";
import { relativeDate } from "@/shell/format";
import { useNow } from "@/shell/useNow";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import type { WorktreeRow as Row } from "@/stores/worktrees";

const props = withDefaults(
  defineProps<{
    rows: Row[];
    /** Lane of each row's branch, by path; 0 when it has none. */
    lanes: Record<string, number>;
    selectedPath: string | null;
    loading?: boolean;
    skeletonRows?: number;
  }>(),
  { loading: false, skeletonRows: 4 },
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
const grid = ref<HTMLElement | null>(null);

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

// A row that disappeared (removed, pruned) leaves the focus on its neighbour; the first rows
// take the focus when nothing else has it (the dashboard opened before its list arrived),
// never from a sidebar tab the user is still moving through.
watch(rowCount, (count, previous) => {
  if (count < previous && selectedIndex.value < 0 && count > 0) void focus();
  const idle = document.activeElement === null || document.activeElement === document.body;
  if (previous === 0 && count > 0 && idle) void focus();
});

defineExpose({ focus });
</script>

<template>
  <div class="flex min-h-0 flex-col" data-testid="worktree-table">
    <div
      role="grid"
      :aria-label="t('worktrees.title')"
      :aria-busy="props.loading ? 'true' : undefined"
      class="worktree-grid flex min-h-0 flex-col"
      @keydown="navigation.onKeydown"
    >
      <div
        role="row"
        class="worktree-table-header grid h-panel-header shrink-0 items-center gap-4 border-b border-line px-3 text-md text-fg-muted whitespace-nowrap"
      >
        <span role="columnheader">{{ t("worktrees.columns.path") }}</span>
        <span role="columnheader">{{ t("worktrees.columns.branch") }}</span>
        <span role="columnheader">{{ t("worktrees.columns.state") }}</span>
        <span role="columnheader">{{ t("worktrees.columns.aheadBehind") }}</span>
        <span role="columnheader">{{ t("worktrees.columns.lastCommit") }}</span>
        <span role="columnheader" class="sr-only">{{ t("worktrees.columns.actions") }}</span>
      </div>
      <div ref="grid" role="rowgroup" class="min-h-0 overflow-y-auto" data-testid="worktree-rows">
        <template v-if="showSkeleton">
          <SkeletonRow v-for="i in props.skeletonRows" :key="i" :index="i - 1" height="list" />
        </template>
        <WorktreeRow
          v-for="(row, index) in props.rows"
          :key="row.path"
          :data-index="index"
          :path="row.path"
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
          @select="navigation.select(index)"
          @activate="emit('activate', row.path)"
          @compare="emit('compare', row.path)"
          @terminal="emit('terminal', row.path)"
          @editor="emit('editor', row.path)"
          @remove="emit('remove', row.path)"
          @menu="(x, y) => emit('menu', row.path, x, y)"
        />
      </div>
    </div>
    <p class="shrink-0 px-3 py-3 text-md text-fg-muted" data-testid="worktree-footer">
      {{ t("worktrees.footer") }}
    </p>
  </div>
</template>

<style scoped>
/* The header shares the row's column widths; the ahead/behind column is
   84px here, where the row's own default is 56. */
.worktree-grid {
  --worktree-ahead-w: 84px;
}
.worktree-table-header {
  grid-template-columns:
    var(--worktree-path-w, 200px) var(--worktree-branch-w, 200px) var(--worktree-state-w, 96px)
    var(--worktree-ahead-w, 84px) minmax(0, 1fr) auto;
}
</style>
