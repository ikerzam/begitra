<script setup lang="ts">
// The virtualised rows of one file: hunk headers with their reviewed control, unified lines
// or side-by-side pairs with the intra-line emphasis and the two-tone highlighting, heights
// from the wrap setting and the measured column width, n/p over hunks and ]/[ over the
// changed symbols.

import { computed, ref, watch } from "vue";

import DiffRow from "@/components/DiffRow.vue";
import HunkRow from "@/components/HunkRow.vue";
import type { FileChange, Hunk } from "@/ipc/schemas";
import { useShortcut } from "@/shortcuts/useShortcut";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";

import { hunkRange, hunkRowIndexes, hunkSymbol, lineKind, rowHeights, rowsOf } from "./diffRows";
import LineContent from "./LineContent.vue";
import SideBySideRow from "./SideBySideRow.vue";
import { useColumns } from "./useColumns";
import { useHighlight } from "./useHighlight";
import { useHunkNavigation } from "./useHunkNavigation";
import { jumpToSymbol, useSymbols } from "./useSymbols";
import { useVariableRows } from "./useVariableRows";

const props = defineProps<{
  file: FileChange;
  /** The hunks shown; the file's own, or one made from a file read whole. */
  hunks: Hunk[];
  /** Whether the highlighter should be asked (not for collapsed cards). */
  highlighted: boolean;
}>();

const repo = useRepoStore();
const review = useReviewStore();
const body = ref<HTMLElement | null>(null);

const root = computed(() => repo.repo?.root ?? null);
const target = computed(() => review.target);
const file = computed<FileChange | null>(() => props.file);
const layout = computed(() => review.layout);
const rows = computed(() => rowsOf(props.hunks, review.layout));

const { columns } = useColumns(body, layout);
const heights = computed(() => rowHeights(rows.value, review.wrap, columns.value));
const virtual = useVariableRows(body, heights);
const hunkTops = computed(() => hunkRowIndexes(rows.value).map((index) => virtual.rowTop(index)));

const highlight = useHighlight(
  root,
  target,
  file,
  computed(() => props.highlighted),
);
const symbols = useSymbols(root, target, file, rows);

const rendered = computed(() => {
  const { start, end } = virtual.range.value;
  const list: number[] = [];
  for (let i = start; i < end; i += 1) list.push(i);
  return list;
});

// A new file starts at the top.
watch(
  () => props.file.path,
  () => virtual.scrollToTop(0),
);

function scrollTo(top: number): void {
  const element = body.value;
  if (!element) return;
  element.scrollTop = top;
  virtual.onScroll();
}

useHunkNavigation({ offsets: hunkTops, scrollTop: virtual.scrollTop, scrollTo });

const viewport = {
  scrollTop: virtual.scrollTop,
  rowTop: (index: number) => virtual.rowTop(index),
  scrollToRow: (index: number) => virtual.scrollToTop(index),
};

function moveSymbol(step: 1 | -1): void {
  const name = jumpToSymbol(symbols.changed.value, viewport, step);
  if (name !== null) review.currentSymbol = name;
}

useShortcut("next-symbol", () => moveSymbol(1));
useShortcut("previous-symbol", () => moveSymbol(-1));

function onScroll(): void {
  virtual.onScroll();
  review.currentSymbol = null;
}

defineExpose({ moveSymbol, changedSymbols: symbols.changed });
</script>

<template>
  <div
    ref="body"
    class="diff-body relative min-h-0 flex-1 overflow-auto font-mono text-code"
    data-testid="diff-body"
    tabindex="0"
    @scroll.passive="onScroll"
  >
    <div
      class="relative"
      :style="{ height: `${virtual.totalHeight.value}px` }"
      data-testid="diff-rows"
    >
      <template v-for="index in rendered" :key="rows[index]?.key ?? index">
        <div
          class="absolute right-0 left-0"
          :style="{ top: `${virtual.rowTop(index)}px`, minHeight: `${heights[index]}px` }"
          :data-row="index"
        >
          <template v-if="rows[index]?.kind === 'hunk'">
            <HunkRow
              data-hunk
              :range="hunkRange(rows[index].hunk)"
              :symbol="hunkSymbol(rows[index].hunk)"
              :reviewed="review.isHunkReviewed(props.file.path, rows[index].hunk)"
              @toggle-reviewed="review.toggleHunkReviewed(props.file.path, rows[index].hunk)"
            />
          </template>
          <template v-else-if="rows[index]?.kind === 'line'">
            <DiffRow
              :kind="lineKind(rows[index].line)"
              :old-number="rows[index].line.oldNumber ?? undefined"
              :new-number="rows[index].line.newNumber ?? undefined"
              :class="{ 'h-auto min-h-row-diff': review.wrap }"
            >
              <LineContent
                :line="rows[index].line"
                :tokens="highlight.tokensOf(rows[index].line)"
                :wrap="review.wrap"
              />
            </DiffRow>
          </template>
          <template v-else-if="rows[index]?.kind === 'pair'">
            <SideBySideRow
              :left="rows[index].left"
              :right="rows[index].right"
              :left-tokens="rows[index].left ? highlight.tokens.value.old(rows[index].left) : []"
              :right-tokens="rows[index].right ? highlight.tokens.value.new(rows[index].right) : []"
              :wrap="review.wrap"
            />
          </template>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* Tabs take four columns, the width the wrap heights count them with (diffRows.ts). */
.diff-body {
  tab-size: 4;
}
</style>
