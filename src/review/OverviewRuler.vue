<script setup lang="ts">
// The overview ruler in the rows' scrollbar's place: their removed lines in its left half and
// the added ones in its right half, the find's matches across its middle and the current one
// across all of it, at the rows' places scaled to the ruler, and the view as a slider under
// them drawn as the app's scrollbar thumb. A press on the ruler outside the slider brings that place to the middle of the view
// and keeps dragging from there; a press on the slider drags it; the wheel scrolls the rows.
// It repeats what the rows hold for the eye: out of the tab order and hidden from assistive
// technology, like the sideways strip under the rows.

import { computed, ref, useTemplateRef } from "vue";

import type { ThemeName } from "@/stores/settings";

import { LINE_HEIGHT } from "./diffRows";
import {
  scrollForDrag,
  scrollForRulerPoint,
  sliderBox,
  type RulerTick,
  type TickKind,
} from "./ruler";

const props = defineProps<{
  ticks: readonly RulerTick[];
  /** The rows' height, in px. */
  total: number;
  /** The viewport's height, which is the ruler's. */
  height: number;
  scrollTop: number;
  /** The rows' code theme, or none for the window's. */
  theme?: ThemeName | undefined;
}>();
const emit = defineEmits<{ scrollTo: [top: number]; scrollBy: [dy: number] }>();

const root = useTemplateRef<HTMLElement>("root");

/** Each kind's lane: removed on the old side's left, added on the new side's right. */
const LANES: Record<TickKind, string> = {
  removed: "left-0 w-1/2 bg-del",
  added: "right-0 w-1/2 bg-add",
  match: "left-1/4 w-1/2 bg-warn",
  current: "inset-x-0 bg-warn",
};

const slider = computed(() => sliderBox(props.scrollTop, props.total, props.height));

/** The drag in progress: its pointer, where it started and the scroll position it moves. */
let drag: { pointer: number; startY: number; from: number } | null = null;
const dragging = ref(false);

function onPointerDown(event: PointerEvent): void {
  const box = slider.value;
  const element = root.value;
  if (event.button !== 0 || !element) return;
  // Neither the focus nor a text selection leaves the rows, even when nothing scrolls.
  event.preventDefault();
  if (!box) return;
  const y = event.clientY - element.getBoundingClientRect().top;
  let from = props.scrollTop;
  if (y < box.top || y > box.top + box.height) {
    from = scrollForRulerPoint(y, props.total, props.height);
    emit("scrollTo", from);
  }
  try {
    element.setPointerCapture?.(event.pointerId);
  } catch {
    // A pointer the browser does not track: the drag follows the moves over the ruler.
  }
  drag = { pointer: event.pointerId, startY: event.clientY, from };
  dragging.value = true;
}

function onPointerMove(event: PointerEvent): void {
  const box = slider.value;
  if (!drag || event.pointerId !== drag.pointer || !box) return;
  const dy = event.clientY - drag.startY;
  emit("scrollTo", scrollForDrag(drag.from, dy, props.total, props.height, box.height));
}

function onPointerUp(event: PointerEvent): void {
  if (!drag || event.pointerId !== drag.pointer) return;
  if (root.value?.hasPointerCapture?.(event.pointerId)) {
    root.value.releasePointerCapture(event.pointerId);
  }
  drag = null;
  dragging.value = false;
}

/** The wheel scrolls the rows: by pixels, lines of the diff or pages of the view. */
function onWheel(event: WheelEvent): void {
  const unit =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? LINE_HEIGHT
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? props.height
        : 1;
  emit("scrollBy", event.deltaY * unit);
}
</script>

<template>
  <div
    ref="root"
    class="relative w-3 shrink-0 touch-none overflow-hidden bg-app select-none"
    :data-theme="props.theme"
    aria-hidden="true"
    data-testid="overview-ruler"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @lostpointercapture="onPointerUp"
    @wheel.prevent="onWheel"
  >
    <!-- The slider is the app's scrollbar thumb (main.css): a pill inset 2px, under the ticks,
         which stay readable over it. -->
    <div
      v-if="slider"
      class="absolute inset-x-0 rounded-full border-2 border-transparent bg-clip-padding"
      :class="dragging ? 'bg-fg-muted' : 'bg-line-strong hover:bg-fg-disabled'"
      :style="{ top: `${slider.top}px`, height: `${slider.height}px` }"
      data-testid="overview-ruler-slider"
    />
    <!-- Memoised on the ticks: a scroll moves the slider without patching up to a thousand
         ticks. -->
    <div v-memo="[props.ticks]" class="pointer-events-none absolute inset-0">
      <div
        v-for="(tick, index) in props.ticks"
        :key="index"
        class="absolute"
        :class="LANES[tick.kind]"
        :style="{ top: `${tick.top}px`, height: `${tick.height}px` }"
        :data-kind="tick.kind"
      />
    </div>
  </div>
</template>
