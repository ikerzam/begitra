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
    /** 24px square by default; `lg` is the 32px hit area of the sidebar rail. */
    size?: "md" | "lg";
  }>(),
  { icon: undefined, pressed: undefined, disabled: false, size: "md" },
);
</script>

<template>
  <button
    type="button"
    :disabled="props.disabled"
    :aria-label="props.label"
    :aria-pressed="props.pressed"
    :title="props.label"
    class="inline-flex shrink-0 items-center justify-center rounded-sm enabled:hover:bg-hover enabled:hover:text-fg enabled:active:bg-active disabled:text-fg-disabled"
    :class="[
      props.size === 'lg' ? 'size-6' : 'size-5',
      props.pressed ? 'bg-selected text-fg' : 'text-fg-secondary',
    ]"
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
