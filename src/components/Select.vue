<script setup lang="ts">
import { ChevronDown } from "@lucide/vue";

import type { ControlSize, SelectOption } from "./types";

const props = withDefaults(
  defineProps<{
    options: SelectOption[];
    /** Accessible name when no visible label element points at the control. */
    label?: string;
    disabled?: boolean;
    size?: ControlSize;
    /** A control whose value narrows something is filled with `--bg-selected`. */
    active?: boolean;
  }>(),
  { label: undefined, disabled: false, size: "md", active: false },
);

const model = defineModel<string>({ default: "" });
</script>

<template>
  <div class="relative inline-flex w-full items-center">
    <select
      v-model="model"
      :disabled="props.disabled"
      :aria-label="props.label"
      class="w-full appearance-none rounded-sm border border-line-strong pr-6 pl-3 text-md text-fg enabled:hover:bg-hover disabled:border-line disabled:text-fg-disabled"
      :class="[props.size === 'lg' ? 'h-6' : 'h-control', props.active ? 'bg-selected' : 'bg-app']"
      :data-active="props.active ? 'true' : undefined"
    >
      <option
        v-for="option in props.options"
        :key="option.value"
        :value="option.value"
        :disabled="option.disabled"
      >
        {{ option.label }}
      </option>
    </select>
    <ChevronDown
      :size="16"
      :stroke-width="1.5"
      aria-hidden="true"
      class="pointer-events-none absolute right-3"
      :class="props.disabled ? 'text-fg-disabled' : 'text-fg-secondary'"
    />
  </div>
</template>
