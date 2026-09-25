<script setup lang="ts">
// A zero-width handle over the hairline of a pane (the pane draws the line inside its own
// width) that resizes it: drag it, or focus it and use the arrow keys (16px per press); a
// double click asks for the pane's default.

import { onBeforeUnmount } from "vue";

const props = withDefaults(
  defineProps<{
    /** Current size of the pane, in px. */
    size: number;
    /** 1 when dragging right grows the pane (a left pane), -1 for a pane on the right. */
    direction?: 1 | -1;
    label: string;
    /** Limits of the pane, in px, for assistive technology. */
    min?: number;
    max?: number;
  }>(),
  { direction: 1, min: undefined, max: undefined },
);
const emit = defineEmits<{ resize: [px: number]; reset: [] }>();

let startX = 0;
let startSize = 0;

function onMove(event: MouseEvent): void {
  emit("resize", startSize + (event.clientX - startX) * props.direction);
}

function stop(): void {
  window.removeEventListener("mousemove", onMove);
  window.removeEventListener("mouseup", stop);
}

function start(event: MouseEvent): void {
  startX = event.clientX;
  startSize = props.size;
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", stop);
  event.preventDefault();
}

function onKeydown(event: KeyboardEvent): void {
  const step = event.key === "ArrowRight" ? 16 : event.key === "ArrowLeft" ? -16 : 0;
  if (step === 0) return;
  emit("resize", props.size + step * props.direction);
  event.preventDefault();
}

onBeforeUnmount(stop);
</script>

<template>
  <div
    role="separator"
    aria-orientation="vertical"
    tabindex="0"
    :aria-label="props.label"
    :aria-valuenow="props.size"
    :aria-valuemin="props.min"
    :aria-valuemax="props.max"
    :data-direction="props.direction"
    class="pane-resizer relative shrink-0 cursor-col-resize"
    data-testid="pane-resizer"
    @mousedown="start"
    @dblclick="emit('reset')"
    @keydown="onKeydown"
  ></div>
</template>

<style scoped>
/* No width of its own, so the pane keeps its exact size; a 6px hit area straddles the edge. */
.pane-resizer {
  width: 0;
}

.pane-resizer::before {
  content: "";
  position: absolute;
  inset: 0 -3px;
}

/* On hover the pane's hairline turns strong: the line is drawn over it, on the pane's side. */
.pane-resizer::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 1px;
}

.pane-resizer[data-direction="1"]::after {
  left: -1px;
}

.pane-resizer:hover::after {
  background: var(--border-strong);
}
</style>
