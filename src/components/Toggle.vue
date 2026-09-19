<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    /** Accessible name; the visible label lives in the surrounding form row. */
    label: string;
    disabled?: boolean;
  }>(),
  { disabled: false },
);

const model = defineModel<boolean>({ default: false });

/* Monochrome: on is `--text` with a `--bg-app` knob, off is `--border-strong` with a grey knob. */
const trackClass = computed(() => {
  if (props.disabled) return model.value ? "bg-fg-disabled" : "bg-line";
  return model.value ? "bg-fg" : "bg-line-strong";
});

const knobClass = computed(() => {
  if (props.disabled) return model.value ? "bg-app" : "bg-fg-disabled";
  return model.value ? "bg-app" : "bg-fg-secondary";
});

function toggle(): void {
  if (!props.disabled) model.value = !model.value;
}
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="model"
    :aria-label="props.label"
    :disabled="props.disabled"
    class="inline-flex h-icon w-control shrink-0 items-center rounded-full border-2 border-transparent"
    :class="[trackClass, model ? 'justify-end' : 'justify-start']"
    @click="toggle"
  >
    <span aria-hidden="true" class="size-3 rounded-full" :class="knobClass" />
  </button>
</template>
