<script setup lang="ts">
// One row of the side-by-side layout: the old side on the left, the new on the right, each
// with its number, marker and text; a side without a line is a `--bg-hover` gap.

import { computed } from "vue";

import type { DiffLine, Token } from "@/ipc/schemas";

import type { LineMark } from "./diffRows";
import LineContent from "./LineContent.vue";

const props = withDefaults(
  defineProps<{
    left: DiffLine | null;
    right: DiffLine | null;
    leftTokens?: Token[];
    rightTokens?: Token[];
    wrap?: boolean;
    /** The side's changed line is picked for a partial stage: `--bg-selected` in place of the tint. */
    leftSelected?: boolean;
    rightSelected?: boolean;
    /** The selection cursor rests on this row. */
    cursor?: boolean;
    /** The find's matches on each side's line. */
    leftMarks?: LineMark[];
    rightMarks?: LineMark[];
  }>(),
  {
    leftTokens: () => [],
    rightTokens: () => [],
    wrap: false,
    leftSelected: false,
    rightSelected: false,
    cursor: false,
    leftMarks: () => [],
    rightMarks: () => [],
  },
);

/** A click on one side, for the line selection of the changes screen. */
const emit = defineEmits<{ selectSide: [side: "left" | "right", event: MouseEvent] }>();

function cellClass(line: DiffLine | null, selected: boolean): string {
  if (!line) return "bg-hover";
  if (selected) return "bg-selected";
  if (line.kind === "added") return "bg-add-bg";
  if (line.kind === "removed") return "bg-del-bg";
  return "hover:bg-hover";
}

function marker(line: DiffLine | null): string {
  if (!line) return "";
  return line.kind === "added" ? "+" : line.kind === "removed" ? "-" : "";
}

function markerClass(line: DiffLine | null): string {
  if (line?.kind === "added") return "text-add";
  if (line?.kind === "removed") return "text-del";
  return "text-fg-muted";
}

const leftNumber = computed(() => props.left?.oldNumber ?? props.left?.newNumber ?? "");
const rightNumber = computed(() => props.right?.newNumber ?? props.right?.oldNumber ?? "");
</script>

<template>
  <div
    class="grid min-h-row-diff grid-cols-2 items-stretch font-mono text-code"
    :class="{ 'side-cursor': props.cursor }"
    data-testid="side-by-side-row"
  >
    <div
      class="side-cell grid items-start border-r border-line"
      :class="cellClass(props.left, props.leftSelected)"
      :data-selected="props.leftSelected ? 'true' : undefined"
      data-testid="side-left"
      @click="(event) => emit('selectSide', 'left', event)"
    >
      <span class="pr-2 text-right text-mono-sm text-fg-muted select-none">{{ leftNumber }}</span>
      <span class="text-center select-none" :class="markerClass(props.left)">{{
        marker(props.left)
      }}</span>
      <LineContent
        v-if="props.left"
        class="text-fg"
        :line="props.left"
        :tokens="props.leftTokens"
        :wrap="props.wrap"
        :marks="props.leftMarks"
      />
    </div>
    <div
      class="side-cell grid items-start"
      :class="cellClass(props.right, props.rightSelected)"
      :data-selected="props.rightSelected ? 'true' : undefined"
      data-testid="side-right"
      @click="(event) => emit('selectSide', 'right', event)"
    >
      <span class="pr-2 text-right text-mono-sm text-fg-muted select-none">{{ rightNumber }}</span>
      <span class="text-center select-none" :class="markerClass(props.right)">{{
        marker(props.right)
      }}</span>
      <LineContent
        v-if="props.right"
        class="text-fg"
        :line="props.right"
        :tokens="props.rightTokens"
        :wrap="props.wrap"
        :marks="props.rightMarks"
      />
    </div>
  </div>
</template>

<style scoped>
/* Each side: one gutter and the marker of `DiffRow`, then the text. */
.side-cell {
  grid-template-columns: var(--diff-gutter-w, 44px) var(--diff-marker-w, 22px) minmax(0, 1fr);
  line-height: var(--row-diff, 20px);
}

/* The selection cursor is the focus ring drawn inside the row (see DiffRow). */
.side-cursor {
  box-shadow: inset 0 0 0 2px var(--focus-ring);
}
</style>
