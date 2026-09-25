<script setup lang="ts">
// The open list of a select or of a field's suggestions: options in the overlay treatment of
// the app's menus, fixed under its anchor (above it, or on the side with more room and cut to
// it, where the room under it is short), at least the anchor's width, the active row kept in
// view and the selected one checked; the pointer's row takes --bg-hover and the keys' row
// --bg-selected, as in the menus. It never takes the focus: the control keeps it and names the
// active row through aria-activedescendant. A press outside it and its anchor, a scroll
// outside it and a window resize close it, as the platform's list does; a modal list (a
// select's) also keeps that press, and its click, from reaching anything else, so a press on
// a dialog's backdrop closes the list and not the dialog.

import { Check } from "@lucide/vue";
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { EDGE, hangFrom, viewportSize } from "./placement";
import type { SelectOption } from "./types";

const props = withDefaults(
  defineProps<{
    /** The id of the listbox; each option's id is `<id>-<index>`. */
    id: string;
    options: readonly SelectOption[];
    /** The control the list hangs from. */
    anchor: HTMLElement;
    /** The row the keys point at; -1 for none. */
    active: number;
    /** The value shown as chosen, with its check; null for none (a field's suggestions). */
    selected?: string | null;
    /** Accessible name of the list. */
    label?: string;
    /** A press outside only closes the list (a select's), rather than also acting where it lands. */
    modal?: boolean;
  }>(),
  { selected: null, label: undefined, modal: false },
);

const emit = defineEmits<{ choose: [index: number]; close: [] }>();

/* Ten rows show before the list scrolls: 10 × 28px rows, the 4px padding and the 1px border
   on both sides. */
const MAX_HEIGHT = 290;

const list = ref<HTMLElement | null>(null);
const place = ref<{ left: number; top: number; height: number | null }>({
  left: 0,
  top: 0,
  height: null,
});
const room = ref({ minWidth: 0, maxWidth: 0 });

function measure(): void {
  const element = list.value;
  if (!element) return;
  const anchor = props.anchor.getBoundingClientRect();
  const viewport = viewportSize();
  const box = element.getBoundingClientRect();
  // The natural height: every row (the scroll height and the border) up to ten.
  const border = element.offsetHeight - element.clientHeight;
  const natural = box.height === 0 ? 0 : Math.min(element.scrollHeight + border, MAX_HEIGHT);
  place.value = hangFrom(anchor, { width: box.width, height: natural }, viewport);
  room.value = { minWidth: anchor.width, maxWidth: viewport.width - 2 * EDGE };
}

function scrollActive(): void {
  const row = list.value?.children[props.active];
  if (row instanceof HTMLElement) row.scrollIntoView?.({ block: "nearest" });
}

/* The click that ends a press a modal list kept goes nowhere; a press that ends in no click
   leaves nothing behind once it is released, or once the next one starts. */
function swallowClick(): void {
  const stop = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
  };
  const release = (): void => {
    window.setTimeout(() => document.removeEventListener("click", stop, true), 0);
  };
  document.addEventListener("click", stop, true);
  for (const type of ["pointerup", "pointercancel", "pointerdown"]) {
    document.addEventListener(type, release, { capture: true, once: true });
  }
}

function onPointerDownOutside(event: PointerEvent): void {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (list.value?.contains(target) || props.anchor.contains(target)) return;
  if (props.modal) {
    event.preventDefault();
    event.stopPropagation();
    swallowClick();
  }
  emit("close");
}

function onScroll(event: Event): void {
  if (event.target instanceof Node && list.value?.contains(event.target)) return;
  emit("close");
}

function onResize(): void {
  emit("close");
}

watch(
  () => props.active,
  () => void nextTick(scrollActive),
);

/* Rows that come or go while open (a suggestion list narrowing as the user types) place the
   list again; so does a list whose size changes otherwise. */
watch(
  () => props.options,
  () => void nextTick(measure),
);
let resized: ResizeObserver | null = null;

onMounted(() => {
  measure();
  void nextTick(() => {
    measure();
    scrollActive();
  });
  document.addEventListener("pointerdown", onPointerDownOutside, true);
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onResize);
  if (list.value && typeof ResizeObserver !== "undefined") {
    resized = new ResizeObserver(() => measure());
    resized.observe(list.value);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onPointerDownOutside, true);
  document.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", onResize);
  resized?.disconnect();
});
</script>

<template>
  <div
    :id="props.id"
    ref="list"
    role="listbox"
    :aria-label="props.label"
    class="fixed z-50 flex w-max flex-col overflow-y-auto rounded-lg border border-line-strong bg-raised p-1 shadow-overlay"
    :style="{
      left: `${place.left}px`,
      top: `${place.top}px`,
      minWidth: `${room.minWidth}px`,
      maxWidth: room.maxWidth > 0 ? `${room.maxWidth}px` : undefined,
      maxHeight: `${place.height ?? MAX_HEIGHT}px`,
    }"
    data-testid="option-list"
    @mousedown.prevent
    @click.prevent
  >
    <div
      v-for="(option, index) in props.options"
      :id="`${props.id}-${index}`"
      :key="option.value"
      role="option"
      :aria-selected="option.value === props.selected"
      :aria-disabled="option.disabled ? 'true' : undefined"
      :data-value="option.value"
      class="flex h-control w-full shrink-0 cursor-default items-center gap-2 rounded-sm px-2 text-md whitespace-nowrap"
      :class="
        option.disabled
          ? 'text-fg-disabled'
          : ['text-fg', index === props.active ? 'bg-selected' : 'hover:bg-hover']
      "
      data-testid="option"
      @click="!option.disabled && emit('choose', index)"
    >
      <span class="flex-1 truncate">{{ option.label }}</span>
      <Check
        v-if="option.value === props.selected"
        :size="16"
        :stroke-width="1.5"
        aria-hidden="true"
        class="shrink-0 text-fg-secondary"
      />
    </div>
  </div>
</template>
