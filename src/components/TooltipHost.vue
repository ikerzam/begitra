<script setup lang="ts">
// The app's tooltip: one bubble for the element under the pointer, or
// with the keyboard's focus, that names a hint in `data-tooltip` (and a shortcut in
// `data-tooltip-keys`). It shows once the pointer has rested on the element, or the focus a
// key moved has stayed there, for half a second; the pointer moving on while a bubble shows,
// or just after one hid, shows the next at once, while keys always wait, so walking a list
// does not flash a bubble per row. It hides when the pointer or the focus leaves, on a press
// (and stays hidden until the pointer leaves that element), on any key, on a scroll and on a
// resize. It is fixed to the window and placed by hangFrom, so no container clips it, and
// aria-hidden: every element carries its hint for assistive technology itself.

import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";

import Kbd from "./Kbd.vue";
import { hangFrom, viewportSize } from "./placement";

/** How long the pointer rests, or the focus stays, before a bubble shows. */
const SHOW_DELAY = 500;
/** How soon after a bubble hid the next shows at once, as the platform's tooltips reshow. */
const RESHOW = 300;

const shown = ref(false);
const measured = ref(false);
const text = ref("");
const keys = ref("");
const place = ref({ left: 0, top: 0 });
const bubble = ref<HTMLElement | null>(null);

/** The element the bubble shows for, or will once the delay is over. */
let trigger: HTMLElement | null = null;
/** The element a press hid the bubble of, until the pointer leaves it. */
let pressed: HTMLElement | null = null;
let timer: number | undefined;
let hiddenAt = Number.NEGATIVE_INFINITY;
/** Whether the last input was a key, so a focus it moved may show a bubble. */
let keyboard = false;

function hintOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>("[data-tooltip]");
  return element?.dataset.tooltip ? element : null;
}

function cancel(): void {
  window.clearTimeout(timer);
  timer = undefined;
}

function hide(): void {
  cancel();
  if (shown.value) hiddenAt = Date.now();
  shown.value = false;
  trigger = null;
}

function show(): void {
  timer = undefined;
  if (!trigger?.isConnected) return;
  text.value = trigger.dataset.tooltip ?? "";
  keys.value = trigger.dataset.tooltipKeys ?? "";
  // Measured at the window's origin, whatever the last bubble's place was.
  place.value = { left: 0, top: 0 };
  measured.value = false;
  shown.value = true;
  void nextTick(measure);
}

/* Rendered hidden first, then placed from its measured size. */
function measure(): void {
  if (!bubble.value || !trigger) return;
  const box = bubble.value.getBoundingClientRect();
  const at = hangFrom(
    trigger.getBoundingClientRect(),
    { width: box.width, height: box.height },
    viewportSize(),
  );
  place.value = { left: at.left, top: at.top };
  measured.value = true;
}

function schedule(element: HTMLElement, pointer: boolean): void {
  if (element === trigger) return;
  const warm = pointer && (shown.value || Date.now() - hiddenAt < RESHOW);
  hide();
  trigger = element;
  if (warm) show();
  else timer = window.setTimeout(show, SHOW_DELAY);
}

function onPointerOver(event: PointerEvent): void {
  const element = hintOf(event.target);
  if (element === null) hide();
  else if (element !== pressed) schedule(element, true);
}

function onPointerOut(event: PointerEvent): void {
  const to = event.relatedTarget;
  const inside = (element: HTMLElement | null) => to instanceof Node && !!element?.contains(to);
  if (pressed && !inside(pressed)) pressed = null;
  if (trigger && !inside(trigger)) hide();
}

function onPointerDown(event: PointerEvent): void {
  keyboard = false;
  pressed = hintOf(event.target);
  hide();
}

function onKeyDown(): void {
  keyboard = true;
  hide();
  hiddenAt = Number.NEGATIVE_INFINITY;
}

function onFocusIn(event: FocusEvent): void {
  if (!keyboard) return;
  const element = hintOf(event.target);
  if (element) schedule(element, false);
}

function onFocusOut(event: FocusEvent): void {
  if (trigger && event.target instanceof Node && trigger.contains(event.target)) hide();
}

const listeners: [string, EventListener][] = [
  ["pointerover", onPointerOver as EventListener],
  ["pointerout", onPointerOut as EventListener],
  ["pointerdown", onPointerDown as EventListener],
  ["keydown", onKeyDown],
  ["focusin", onFocusIn as EventListener],
  ["focusout", onFocusOut as EventListener],
  ["scroll", hide],
];

onMounted(() => {
  for (const [type, listener] of listeners) document.addEventListener(type, listener, true);
  window.addEventListener("resize", hide);
});

onBeforeUnmount(() => {
  cancel();
  for (const [type, listener] of listeners) document.removeEventListener(type, listener, true);
  window.removeEventListener("resize", hide);
});
</script>

<template>
  <div
    v-if="shown"
    ref="bubble"
    role="tooltip"
    aria-hidden="true"
    class="tooltip-bubble pointer-events-none fixed z-50 inline-flex w-max items-center gap-2 rounded-md border border-line-strong bg-raised px-2 py-1 text-sm text-fg shadow-overlay"
    :style="{
      left: `${place.left}px`,
      top: `${place.top}px`,
      visibility: measured ? undefined : 'hidden',
    }"
    data-testid="tooltip"
  >
    <span>{{ text }}</span>
    <Kbd v-if="keys" :keys="keys" />
  </div>
</template>

<style scoped>
/* Its own width wherever it stands (max-content, so the room left of a place near the
   window's right edge cannot squeeze it before it is measured); a long path wraps anywhere
   rather than leaving the window. */
.tooltip-bubble {
  max-width: calc(100vw - 16px);
  overflow-wrap: anywhere;
}
</style>
