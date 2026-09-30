<script setup lang="ts">
// A list's rows that collapse when the user's action removes one and expand when it adds one
// (`src/motion`): a `TransitionGroup` while the list is short enough
// to measure on every render, a plain element past `MOTION_MAX_ROWS`. The rows move only while
// a store armed the list. A leaving row turns inert, so it takes no pointer and drops the focus,
// which the list puts back on its selected row. The attributes land on the root either way.

import { computed } from "vue";

import { armed, MOTION_MAX_ROWS, type MotionList } from "@/motion/motion";

const props = withDefaults(
  defineProps<{
    list: MotionList;
    /** The rows the list holds now. */
    count: number;
    tag?: string;
  }>(),
  { tag: "div" },
);

const measured = computed(() => props.count <= MOTION_MAX_ROWS);

function beforeLeave(element: Element): void {
  element.setAttribute("inert", "");
  element.setAttribute("aria-hidden", "true");
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
   without a fixed height reach its own. */
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
  height: 0;
  min-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  opacity: 0;
}

.row-motion-leave-active {
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .row-motion-enter-active,
  .row-motion-leave-active {
    transition: none;
  }
}
</style>
