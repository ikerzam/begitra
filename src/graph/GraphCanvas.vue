<script setup lang="ts">
// The lane area of the commit list: one canvas the size of the viewport, kept at its top with
// `sticky`, redrawn on scroll and on data change with the geometry of the rendered rows. Lane
// colours come from the `--lane-n` tokens (read through `getComputedStyle`, refreshed when the
// theme attribute changes); the overflow marker is drawn in `--text-muted`.

import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import { LANE_COUNT, laneIndex } from "@/components/lanes";
import type { CommitNode } from "@/ipc/schemas";

import {
  DOT_RADIUS,
  EDGE_WIDTH,
  graphGeometry,
  LANE_AREA_WIDTH,
  PANEL_LAYOUT,
  ROW_HEIGHT,
  type LaneLayout,
} from "./useGraphGeometry";

const props = withDefaults(
  defineProps<{
    commits: readonly CommitNode[];
    start: number;
    end: number;
    scrollTop: number;
    /** Viewport height in CSS pixels. */
    height: number;
    flat?: boolean;
    width?: number;
    layout?: LaneLayout;
    rowHeight?: number;
  }>(),
  { flat: false, width: LANE_AREA_WIDTH, layout: () => PANEL_LAYOUT, rowHeight: ROW_HEIGHT },
);

const canvas = ref<HTMLCanvasElement | null>(null);
let colours: string[] = [];
let mutedText = "";
let font = "";
let frame = 0;
let scheduled = false;
let observer: MutationObserver | null = null;

/** Reads the lane tokens; called once and again when the theme attribute changes. */
function readTokens(): void {
  const style = getComputedStyle(document.documentElement);
  colours = Array.from({ length: LANE_COUNT }, (_, i) =>
    style.getPropertyValue(`--lane-${i + 1}`).trim(),
  );
  mutedText = style.getPropertyValue("--text-muted").trim();
  const body = getComputedStyle(document.body);
  font = `12px ${body.fontFamily || "sans-serif"}`;
}

function colourOf(lane: number): string {
  return colours[laneIndex(lane + 1) - 1] ?? mutedText;
}

function draw(): void {
  const element = canvas.value;
  const context = element?.getContext("2d");
  if (!element || !context) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(props.width * dpr);
  const height = Math.round(props.height * dpr);
  if (element.width !== width || element.height !== height) {
    element.width = width;
    element.height = height;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, props.width, props.height);
  const geometry = graphGeometry({
    commits: props.commits,
    start: props.start,
    end: props.end,
    scrollTop: props.scrollTop,
    rowHeight: props.rowHeight,
    layout: props.layout,
    flat: props.flat,
  });
  context.lineWidth = EDGE_WIDTH;
  context.lineCap = "round";
  for (const segment of geometry.segments) {
    context.strokeStyle = colourOf(segment.lane);
    context.beginPath();
    context.moveTo(segment.fromX, segment.fromY);
    if (segment.curved) {
      // One row of vertical travel: an S curve whose tangents stay vertical at both ends.
      const middle = (segment.fromY + segment.toY) / 2;
      context.bezierCurveTo(segment.fromX, middle, segment.toX, middle, segment.toX, segment.toY);
    } else {
      context.lineTo(segment.toX, segment.toY);
    }
    context.stroke();
  }
  for (const dot of geometry.dots) {
    context.fillStyle = colourOf(dot.lane);
    context.beginPath();
    context.arc(dot.x, dot.y, DOT_RADIUS, 0, Math.PI * 2);
    context.fill();
  }
  if (geometry.overflows.length > 0) {
    context.fillStyle = mutedText;
    context.font = font;
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (const overflow of geometry.overflows) {
      context.fillText(`+${overflow.count}`, props.width - 4, overflow.y);
    }
  }
}

/** Coalesces the redraws of one frame (a scroll event and a page arriving together). */
function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  frame = requestAnimationFrame(() => {
    scheduled = false;
    draw();
  });
}

watch(
  () => [
    props.commits,
    props.start,
    props.end,
    props.scrollTop,
    props.height,
    props.flat,
    props.width,
  ],
  schedule,
);

onMounted(() => {
  readTokens();
  observer = new MutationObserver(() => {
    readTokens();
    schedule();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  draw();
});

onBeforeUnmount(() => {
  observer?.disconnect();
  if (scheduled) cancelAnimationFrame(frame);
});

defineExpose({ draw });
</script>

<template>
  <canvas
    ref="canvas"
    aria-hidden="true"
    data-testid="graph-canvas"
    class="pointer-events-none sticky top-0 left-0 z-10 block"
    :style="{ width: `${props.width}px`, height: `${props.height}px` }"
  />
</template>
