<script setup lang="ts">
import { computed } from "vue";

import type { DiffLineKind } from "./types";

const props = withDefaults(
  defineProps<{
    /** `gap` is the empty 20px cell of a side-by-side pair with no counterpart. */
    kind?: DiffLineKind;
    oldNumber?: number;
    newNumber?: number;
    /** Plain code; use the default slot instead to mark intra-line emphasis spans. */
    code?: string;
    /** A changed line picked for a partial stage: `--bg-selected` in place of the tint. */
    selected?: boolean;
    /** The selection cursor rests here (the keyboard's way to pick lines). */
    cursor?: boolean;
  }>(),
  {
    kind: "context",
    oldNumber: undefined,
    newNumber: undefined,
    code: "",
    selected: false,
    cursor: false,
  },
);

const rowClasses: Record<DiffLineKind, string> = {
  context: "hover:bg-hover",
  add: "bg-add-bg",
  del: "bg-del-bg",
  gap: "bg-hover",
};

/* Git's own markers; they are syntax, not copy. */
const markers: Record<DiffLineKind, string> = { context: "", add: "+", del: "-", gap: "" };

const markerClass = computed(() => {
  if (props.kind === "add") return "text-add";
  if (props.kind === "del") return "text-del";
  return "text-fg-muted";
});
</script>

<template>
  <div
    :data-kind="props.kind"
    :data-selected="props.selected ? 'true' : undefined"
    data-testid="diff-row"
    class="diff-row grid h-row-diff items-center font-mono text-code whitespace-pre"
    :class="[
      props.selected ? 'bg-selected' : rowClasses[props.kind],
      { 'diff-row-cursor': props.cursor },
    ]"
  >
    <span
      class="pr-2 text-right text-mono-sm text-fg-muted select-none"
      data-testid="diff-row-old"
      >{{ props.oldNumber ?? "" }}</span
    >
    <span
      class="pr-2 text-right text-mono-sm text-fg-muted select-none"
      data-testid="diff-row-new"
      >{{ props.newNumber ?? "" }}</span
    >
    <span class="text-center select-none" :class="markerClass" data-testid="diff-row-marker">{{
      markers[props.kind]
    }}</span>
    <span class="overflow-hidden text-fg" data-testid="diff-row-code"
      ><slot>{{ props.code }}</slot></span
    >
  </div>
</template>

<style scoped>
/* Default gutter widths; the viewer may widen them for long files. */
.diff-row {
  grid-template-columns:
    var(--diff-gutter-w, 44px) var(--diff-gutter-w, 44px) var(--diff-marker-w, 22px)
    minmax(0, 1fr);
}

/* The cursor is the focus ring drawn inside the row, so it never widens the list. */
.diff-row-cursor {
  box-shadow: inset 0 0 0 2px var(--focus-ring);
}
</style>
