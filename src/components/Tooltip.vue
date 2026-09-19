<script setup lang="ts">
import { ref, useId } from "vue";

import Kbd from "./Kbd.vue";

const props = withDefaults(
  defineProps<{
    label: string;
    /** Shortcut hint rendered as `kbd` after the label. */
    keys?: string;
    placement?: "top" | "bottom";
  }>(),
  { keys: "", placement: "bottom" },
);

const open = ref(false);
const id = useId();

function show(): void {
  open.value = true;
}

function hide(): void {
  open.value = false;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") hide();
}
</script>

<template>
  <span
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
      role="tooltip"
      class="absolute left-0 z-10 inline-flex h-control items-center gap-2 rounded-md border border-line-strong bg-raised px-3 text-md whitespace-nowrap text-fg shadow-overlay"
      :class="props.placement === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'"
    >
      {{ props.label }}
      <Kbd v-if="props.keys" :keys="props.keys" />
    </span>
  </span>
</template>
