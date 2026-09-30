<script setup lang="ts">
// A list's rows that collapse when the user's action removes one and expand when it adds one
// (`src/motion`): a `TransitionGroup` while the list is short enough to measure on every render,
// a plain element past `MOTION_MAX_ROWS`. The rows move only while a store armed the list. A
// leaving row turns inert (no pointer, no focus) and loses the attributes the lists look rows up
// by, so a lookup finds the row that took its place; when it held the focus, `focusLost` asks the
// list to give it to its selected row. The attributes land on the root either way.

import { computed, nextTick } from "vue";

import { armed, MOTION_MAX_ROWS, type MotionList } from "@/motion/motion";

const props = withDefaults(
  defineProps<{
    list: MotionList;
    /** The rows the whole list holds now, every group of it included. */
    count: number;
    tag?: string;
  }>(),
  { tag: "div" },
);

const emit = defineEmits<{
  /** A leaving row held the focus: the list gives it to its selected row. */
  focusLost: [];
}>();

const measured = computed(() => props.count <= MOTION_MAX_ROWS);

/** The attributes the lists find a row by. */
const LOOKUPS = ["data-index", "data-list", "data-path"];

function beforeLeave(element: Element): void {
  const held = element.contains(document.activeElement);
  for (const name of LOOKUPS) element.removeAttribute(name);
  element.setAttribute("inert", "");
  element.setAttribute("aria-hidden", "true");
  if (held) void nextTick(() => emit("focusLost"));
}
</script>

<template>
  <TransitionGroup
    v-if="measured"
    :tag="props.tag"
    name="row-motion"
    :css="armed(props.list)"
    @before-leave="beforeLeave"
  >
    <slot />
  </TransitionGroup>
  <component :is="props.tag" v-else>
    <slot />
  </component>
</template>

<style>
/* The row's height, padding and opacity from and to nothing; `interpolate-size` lets a row
   without a fixed height reach its own. The zeroes are important: a row's own height or
   padding, set by a scoped rule, outranks a class. */
.row-motion-enter-active,
.row-motion-leave-active {
  overflow: hidden;
  interpolate-size: allow-keywords;
  transition-property: height, min-height, padding-top, padding-bottom, opacity;
  transition-duration: var(--motion-duration);
  transition-timing-function: var(--motion-ease);
}

.row-motion-enter-from,
.row-motion-leave-to {
  height: 0 !important;
  min-height: 0 !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  opacity: 0;
}

/* A leaving row is no longer the selected one, whatever its classes still say. */
.row-motion-leave-active {
  pointer-events: none;
  background-color: transparent !important;
  border-color: transparent !important;
}

@media (prefers-reduced-motion: reduce) {
  .row-motion-enter-active,
  .row-motion-leave-active {
    transition: none;
  }
}
</style>
