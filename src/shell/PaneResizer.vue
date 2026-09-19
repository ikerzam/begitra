<script setup lang="ts">
// A vertical hairline between two panes that resizes the pane it belongs to: drag it, or focus
// it and use the arrow keys (16px per press).

import { onBeforeUnmount } from "vue";

const props = withDefaults(
  defineProps<{
    /** Current size of the pane, in px. */
    size: number;
    /** 1 when dragging right grows the pane (a left pane), -1 for a pane on the right. */
    direction?: 1 | -1;
    label: string;
  }>(),
  { direction: 1 },
);
const emit = defineEmits<{ resize: [px: number] }>();

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
    class="pane-resizer relative w-px shrink-0 cursor-col-resize bg-line hover:bg-line-strong focus-visible:bg-accent"
    data-testid="pane-resizer"
    @mousedown="start"
    @keydown="onKeydown"
  ></div>
</template>

<style scoped>
/* A 7px hit area around the 1px line. */
.pane-resizer::after {
  content: "";
  position: absolute;
  inset: 0 -3px;
}
</style>
