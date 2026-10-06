<script setup lang="ts">
import { Check, Minus } from "@lucide/vue";
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    label?: string;
    indeterminate?: boolean;
    disabled?: boolean;
    /** False keeps the box out of the Tab order, where its row is the list's tab stop. */
    focusable?: boolean;
    /** Fills its row: the box on the first line, the label's content taking the rest. */
    block?: boolean;
  }>(),
  { label: "", indeterminate: false, disabled: false, focusable: true, block: false },
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
    class="relative gap-2 text-md select-none"
    :class="[
      props.disabled ? 'text-fg-disabled' : 'text-fg',
      props.block ? 'flex w-full items-start' : 'inline-flex items-center',
    ]"
  >
    <!-- The label is positioned, so the hidden input sits in it: focusing the input scrolls the
         list the box is in, which an input positioned against the page would not. -->
    <input
      v-model="model"
      type="checkbox"
      class="peer sr-only"
      :disabled="props.disabled"
      :tabindex="props.focusable ? undefined : -1"
      :indeterminate="props.indeterminate"
      :aria-checked="props.indeterminate ? 'mixed' : undefined"
    />
    <span
      aria-hidden="true"
      class="checkbox-box flex shrink-0 items-center justify-center rounded-sm border peer-focus-visible:outline-2 peer-focus-visible:outline-focus"
      :class="boxClass"
    >
      <Minus v-if="props.indeterminate" :size="12" :stroke-width="2" />
      <Check v-else-if="model" :size="12" :stroke-width="2" />
    </span>
    <span v-if="props.label || $slots.default" :class="props.block ? 'flex min-w-0 flex-1' : ''">
      <slot>{{ props.label }}</slot>
    </span>
  </label>
</template>

<style scoped>
/* The box is 14px; no spacing step is 14. */
.checkbox-box {
  width: 14px;
  height: 14px;
}
</style>
