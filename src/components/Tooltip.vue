<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, useId } from "vue";

import Kbd from "./Kbd.vue";
import { fitSide, viewportSize, type Side } from "./placement";

const props = withDefaults(
  defineProps<{
    label: string;
    /** Shortcut hint rendered as `kbd` after the label. */
    keys?: string;
    placement?: "top" | "bottom";
    /** The edge of the trigger the bubble lines up with: `end` for triggers at the window's
     * right edge (the top bar's toggles), whose bubble would otherwise leave the window. */
    align?: "start" | "end";
  }>(),
  { keys: "", placement: "bottom", align: "start" },
);

const open = ref(false);
const id = useId();
const trigger = ref<HTMLElement | null>(null);
const bubble = ref<HTMLElement | null>(null);
/* The asked side, turned once the bubble is measured when it would leave the window. */
const side = ref<Side>({ align: props.align, placement: props.placement });

/** The asked side first, then turned where the bubble would leave the window. */
function place(): void {
  side.value = { align: props.align, placement: props.placement };
  void nextTick(() => {
    if (!bubble.value || !trigger.value) return;
    side.value = fitSide(
      bubble.value.getBoundingClientRect(),
      trigger.value.getBoundingClientRect(),
      side.value,
      viewportSize(),
    );
  });
}

function show(): void {
  open.value = true;
  place();
}

function onResize(): void {
  if (open.value) place();
}

onMounted(() => window.addEventListener("resize", onResize));
onBeforeUnmount(() => window.removeEventListener("resize", onResize));

function hide(): void {
  open.value = false;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") hide();
}
</script>

<template>
  <span
    ref="trigger"
    class="relative inline-flex"
    @mouseenter="show"
    @mouseleave="hide"
    @focusin="show"
    @focusout="hide"
    @keydown="onKeydown"
  >
    <!-- The trigger may bind `aria-describedby` to the id it receives. -->
    <slot :id="open ? id : undefined" />
    <span
      v-if="open"
      :id="id"
      ref="bubble"
      role="tooltip"
      class="tooltip-bubble absolute z-10 inline-flex items-center gap-2 rounded-md border border-line-strong bg-raised px-2 py-1 text-sm whitespace-nowrap text-fg shadow-overlay"
      :class="[
        side.placement === 'top' ? 'bottom-full mb-1' : 'top-full mt-1',
        side.align === 'end' ? 'tooltip-end' : 'tooltip-start',
      ]"
    >
      {{ props.label }}
      <Kbd v-if="props.keys" :keys="props.keys" />
    </span>
  </span>
</template>

<style scoped>
/* The strict spacing scale generates no `left-0` or `right-0`: the bubble lines up with the
   trigger's left edge, or its right edge for `align="end"`. */
.tooltip-start {
  left: 0;
}
.tooltip-end {
  right: 0;
}
</style>
