<script setup lang="ts">
import { Check, Minus } from "@lucide/vue";
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    label?: string;
    indeterminate?: boolean;
    disabled?: boolean;
  }>(),
  { label: "", indeterminate: false, disabled: false },
);

const model = defineModel<boolean>({ default: false });

const filled = computed(() => model.value || props.indeterminate);

/* Monochrome: the box fills with `--text` and the mark is drawn in `--bg-app`. */
const boxClass = computed(() => {
  if (props.disabled) {
    return filled.value ? "border-fg-disabled bg-fg-disabled text-app" : "border-line bg-app";
  }
  return filled.value ? "border-fg bg-fg text-app" : "border-line-strong bg-app";
});
</script>

<template>
  <label
    class="inline-flex items-center gap-2 text-md select-none"
    :class="props.disabled ? 'text-fg-disabled' : 'text-fg'"
  >
    <input
      v-model="model"
      type="checkbox"
      class="peer sr-only"
      :disabled="props.disabled"
      :indeterminate="props.indeterminate"
      :aria-checked="props.indeterminate ? 'mixed' : undefined"
    />
    <span
      aria-hidden="true"
      class="flex size-icon shrink-0 items-center justify-center rounded-sm border peer-focus-visible:outline-2 peer-focus-visible:outline-focus"
      :class="boxClass"
    >
      <Minus v-if="props.indeterminate" :size="12" :stroke-width="2" />
      <Check v-else-if="model" :size="12" :stroke-width="2" />
    </span>
    <span v-if="props.label || $slots.default">
      <slot>{{ props.label }}</slot>
    </span>
  </label>
</template>
