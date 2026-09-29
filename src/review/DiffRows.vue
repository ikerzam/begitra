<script setup lang="ts">
// The virtualised rows of one file: hunk headers with their reviewed control (or the actions
// the changes screen puts there), unified lines or side-by-side pairs with the intra-line
// emphasis and the syntax colours, heights from the wrap setting and the measured
// column width, n/p over hunks and ]/[ over the changed symbols. In `selectable` mode the
// changed lines can be picked for a partial stage: a click toggles a line, shift-click extends
// from the last click, and the arrows move a cursor that Space toggles.

import { computed, nextTick, ref, watch } from "vue";

import DiffRow from "@/components/DiffRow.vue";
import HunkRow from "@/components/HunkRow.vue";
import type { FileChange, Hunk } from "@/ipc/schemas";
import { useShortcut } from "@/shortcuts/useShortcut";
import { useExternal } from "@/shell/useExternal";
import { useCodeTheme } from "@/shell/useTheme";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore, type ReviewTarget } from "@/stores/review";

import {
  hunkRange,
  hunkRowIndexes,
  hunkSymbol,
  lineKind,
  newLineOfRow,
  rowHeights,
  rowLineKeys,
  rowsOf,
  selectableRowIndexes,
  type DiffRowModel,
} from "./diffRows";
import LineContent from "./LineContent.vue";
import LineMenu from "./LineMenu.vue";
import SideBySideRow from "./SideBySideRow.vue";
import { useColumns } from "./useColumns";
import { useHighlight } from "./useHighlight";
import { useHunkNavigation } from "./useHunkNavigation";
import { jumpToSymbol, useSymbols } from "./useSymbols";
import { useVariableRows } from "./useVariableRows";

const props = withDefaults(
  defineProps<{
    file: FileChange;
    /** The hunks shown; the file's own, or one made from a file read whole. */
    hunks: Hunk[];
    /** Whether the highlighter should be asked (not for collapsed cards). */
    highlighted: boolean;
    /** Where the file's sides live; the review's target when not given. */
    target?: ReviewTarget | null;
    /** Changed lines can be picked (the changes screen). */
    selectable?: boolean;
    /** The picked lines, by `hunk:line` key. */
    selected?: Set<string>;
    /** The repository the file is in; the open one when not given. */
    root?: string | null;
  }>(),
  { target: undefined, selectable: false, selected: () => new Set<string>(), root: undefined },
);

/** `select`: the keys of the lines a click or Space named; `extend` unions them, else toggles. */
const emit = defineEmits<{ select: [keys: string[], extend: boolean] }>();

const repo = useRepoStore();
const review = useReviewStore();
const codeTheme = useCodeTheme();
const external = useExternal();
const body = ref<HTMLElement | null>(null);

const root = computed(() => (props.root === undefined ? (repo.repo?.root ?? null) : props.root));
const target = computed(() => (props.target === undefined ? review.target : props.target));
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
  computed(() => props.hunks),
  computed(() => props.highlighted),
);
const symbols = useSymbols(root, target, file, rows);

const rendered = computed(() => {
  const { start, end } = virtual.range.value;
  const list: number[] = [];
  for (let i = start; i < end; i += 1) list.push(i);
  return list;
});

// --- Line selection ---------------------------------------------------------------------

/** The row of the last plain click or toggle, where a shift-click extends from. */
const anchorRow = ref<number | null>(null);
/** The row the keyboard cursor rests on, if any. */
const cursorRow = ref<number | null>(null);
const selectableRows = computed(() => selectableRowIndexes(rows.value));

function isSelected(row: DiffRowModel, side?: "left" | "right"): boolean {
  if (row.kind === "line") return props.selected.has(rowLineKeys(row)[0] ?? "");
  if (row.kind !== "pair") return false;
  const index = side === "left" ? row.leftIndex : row.rightIndex;
  return index !== null && props.selected.has(`${row.hunkIndex}:${index}`);
}

/** The keys between two rows inclusive, in row order. */
function keysBetween(a: number, b: number): string[] {
  const keys: string[] = [];
  for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) {
    const row = rows.value[i];
    if (row) keys.push(...rowLineKeys(row));
  }
  return keys;
}

function pick(index: number, keys: string[], extend: boolean): void {
  if (keys.length === 0) return;
  if (extend && anchorRow.value !== null) {
    emit("select", keysBetween(anchorRow.value, index), true);
  } else {
    emit("select", keys, false);
    anchorRow.value = index;
  }
}

function onRowClick(index: number, event: MouseEvent): void {
  if (!props.selectable) return;
  const row = rows.value[index];
  if (!row) return;
  pick(index, rowLineKeys(row), event.shiftKey);
}

function onSideClick(index: number, side: "left" | "right", event: MouseEvent): void {
  if (!props.selectable) return;
  const row = rows.value[index];
  if (row?.kind !== "pair") return;
  const line = side === "left" ? row.left : row.right;
  const lineIndex = side === "left" ? row.leftIndex : row.rightIndex;
  if (!line || line.kind === "context" || lineIndex === null) return;
  pick(index, [`${row.hunkIndex}:${lineIndex}`], event.shiftKey);
}

/** Moves the cursor over the selectable rows; from nothing, the last click or the first row on screen. */
function moveCursor(step: 1 | -1): void {
  const candidates = selectableRows.value;
  if (candidates.length === 0) return;
  let next: number;
  if (cursorRow.value === null && anchorRow.value !== null) {
    next = Math.max(0, candidates.indexOf(anchorRow.value));
  } else if (cursorRow.value === null) {
    const first = virtual.range.value.start;
    const at = candidates.findIndex((index) => index >= first);
    next = at < 0 ? candidates.length - 1 : at;
  } else {
    const at = candidates.indexOf(cursorRow.value);
    next = Math.min(Math.max(at + step, 0), candidates.length - 1);
  }
  const index = candidates[next];
  if (index === undefined) return;
  cursorRow.value = index;
  revealRow(index);
}

function revealRow(index: number): void {
  const element = body.value;
  if (!element) return;
  const top = virtual.rowTop(index);
  const bottom = top + (heights.value[index] ?? 0);
  if (top < element.scrollTop) scrollTo(top);
  else if (bottom > element.scrollTop + element.clientHeight) {
    scrollTo(bottom - element.clientHeight);
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    event.preventDefault();
    openMenuAtKeyboard();
    return;
  }
  if (!props.selectable || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveCursor(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === " " && cursorRow.value !== null) {
    event.preventDefault();
    const row = rows.value[cursorRow.value];
    if (row) pick(cursorRow.value, rowLineKeys(row), event.shiftKey);
  } else if (event.key === "Escape" && cursorRow.value !== null) {
    event.preventDefault();
    cursorRow.value = null;
  }
}

// A new file starts at the top, with no cursor or anchor.
watch(
  () => props.file.path,
  () => {
    virtual.scrollToTop(0);
    anchorRow.value = null;
    cursorRow.value = null;
  },
);

// A layout change renumbers the rows.
watch(layout, () => {
  anchorRow.value = null;
  cursorRow.value = null;
});

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

// --- Open in editor ---------------------------------------------------------------------

/** A deleted file has no new side to open. */
const deleted = computed(() => props.file.status === "deleted");

/** The new side's line of a row, or null for a deleted file. */
function lineOfIndex(index: number): number | null {
  const row = rows.value[index];
  return row && !deleted.value ? newLineOfRow(row, props.hunks) : null;
}

/** The first row still in view at the scroll position: the line at the top of the diff. */
function topRowIndex(): number | null {
  const top = virtual.scrollTop.value;
  for (let index = virtual.range.value.start; index < rows.value.length; index += 1) {
    if (virtual.rowTop(index) + (heights.value[index] ?? 0) > top) return index;
  }
  return rows.value.length > 0 ? 0 : null;
}

/** Opens the working tree's file in the editor, at `line` when there is one. */
function openAtLine(line: number | null): void {
  const at = root.value;
  if (at && !deleted.value) void external.openFile(at, props.file.path, line);
}

/** Where ⇧⌘E opens the file (the viewer binds it): the cursor's line, else the top row's. */
function lineAtTop(): number | null {
  const index = cursorRow.value ?? topRowIndex();
  return index === null ? null : lineOfIndex(index);
}

interface MenuRequest {
  x: number;
  y: number;
  line: number | null;
  selection: string;
}
const menu = ref<MenuRequest | null>(null);
/** Where the keyboard's menu opens: past the two numbers and the marker (110px), at the code. */
const MENU_INDENT = 116;

// The menu names a line of the file it opened on.
watch(
  () => props.file.path,
  () => {
    menu.value = null;
  },
);

/** The menu closed: the focus comes back to the rows unless an item moved it elsewhere. */
function closeMenu(): void {
  menu.value = null;
  void nextTick(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) body.value?.focus({ preventScroll: true });
  });
}

/** The text selected inside the rows, if any. */
function selectionInRows(): string {
  const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
  const element = body.value;
  if (!selection || selection.isCollapsed || !element) return "";
  return element.contains(selection.anchorNode) ? selection.toString() : "";
}

/** A right click on a row: its line, and the selected text when the click is inside it. */
function onContextMenu(event: MouseEvent): void {
  const target = event.target instanceof Element ? event.target : null;
  const element = target?.closest<HTMLElement>("[data-row]");
  if (!element) return;
  event.preventDefault();
  const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
  const text =
    selection && !selection.isCollapsed && target && selection.containsNode(target, true)
      ? selection.toString()
      : "";
  menu.value = {
    x: event.clientX,
    y: event.clientY,
    line: lineOfIndex(Number(element.dataset["row"])),
    selection: text,
  };
}

/**
 * The menu key: the menu of the cursor's row, else of the row at the top of the diff, opened
 * under that row (brought into view first) at the code, with the text selected in the rows.
 */
function openMenuAtKeyboard(): void {
  const element = body.value;
  if (!element) return;
  const index = cursorRow.value ?? topRowIndex();
  if (index !== null) revealRow(index);
  const rect = element.getBoundingClientRect();
  const bottom =
    index === null ? 0 : virtual.rowTop(index) + (heights.value[index] ?? 0) - element.scrollTop;
  menu.value = {
    x: rect.left + MENU_INDENT,
    y: rect.top + Math.min(Math.max(bottom, 0), element.clientHeight),
    line: index === null ? null : lineOfIndex(index),
    selection: selectionInRows(),
  };
}

defineExpose({
  moveSymbol,
  changedSymbols: symbols.changed,
  focus: () => body.value?.focus(),
  lineAtTop,
});
</script>

<template>
  <div
    ref="body"
    class="diff-body relative min-h-0 flex-1 overflow-auto bg-app font-mono text-code text-fg"
    :data-theme="codeTheme"
    :style="{ '--diff-tab-width': review.tabWidth }"
    data-testid="diff-body"
    tabindex="0"
    @scroll.passive="onScroll"
    @keydown="onKeydown"
    @contextmenu="onContextMenu"
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
            >
              <template v-if="$slots.hunkActions" #default>
                <slot
                  name="hunkActions"
                  :hunk="rows[index].hunk"
                  :hunk-index="rows[index].hunkIndex"
                />
              </template>
            </HunkRow>
          </template>
          <template v-else-if="rows[index]?.kind === 'line'">
            <DiffRow
              :kind="lineKind(rows[index].line)"
              :old-number="rows[index].line.oldNumber ?? undefined"
              :new-number="rows[index].line.newNumber ?? undefined"
              :selected="isSelected(rows[index])"
              :cursor="cursorRow === index"
              :class="{
                'h-auto min-h-row-diff': review.wrap,
                'cursor-pointer': props.selectable && rows[index].line.kind !== 'context',
              }"
              @click="(event: MouseEvent) => onRowClick(index, event)"
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
              :left-selected="isSelected(rows[index], 'left')"
              :right-selected="isSelected(rows[index], 'right')"
              :cursor="cursorRow === index"
              @select-side="(side, event) => onSideClick(index, side, event)"
            />
          </template>
        </div>
      </template>
    </div>
    <LineMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :path="props.file.path"
      :line="menu.line"
      :selection="menu.selection"
      @open="openAtLine"
      @close="closeMenu"
    />
  </div>
</template>

<style scoped>
/* Tabs take the settings' width (four columns by default), which the wrap heights count
   them with (diffRows.ts). */
.diff-body {
  tab-size: var(--diff-tab-width, 4);
}
</style>
