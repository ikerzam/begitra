<script setup lang="ts">
import type { Component } from "vue";

const props = withDefaults(
  defineProps<{
    /** Accessible name, also shown as the native tooltip. */
    label: string;
    icon?: Component;
    /** For toggle buttons (layout modes, rail tabs): renders `aria-pressed` and the selected fill. */
    pressed?: boolean;
    disabled?: boolean;
  }>(),
  { icon: undefined, pressed: undefined, disabled: false },
);
</script>

<template>
  <button
    type="button"
    :disabled="props.disabled"
    :aria-label="props.label"
    :aria-pressed="props.pressed"
    :title="props.label"
    class="inline-flex size-control shrink-0 items-center justify-center rounded-sm enabled:hover:bg-hover enabled:hover:text-fg enabled:active:bg-active disabled:text-fg-disabled"
    :class="props.pressed ? 'bg-selected text-fg' : 'text-fg-secondary'"
  >
    <component
      :is="props.icon"
      v-if="props.icon"
      :size="16"
      :stroke-width="1.5"
      aria-hidden="true"
    />
    <slot />
  </button>
</template>
