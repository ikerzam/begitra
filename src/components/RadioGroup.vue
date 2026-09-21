<script setup lang="ts">
// A group of radios drawn as `Checkbox`'s 14px boxes:
// one tab stop, the arrows move the choice, a label and an optional muted hint per option.
// `name` groups the native inputs; the value is the model.

import { Check } from "@lucide/vue";
import { useId } from "vue";

import type { RadioOption } from "./types";

const props = withDefaults(
  defineProps<{
    options: RadioOption[];
    /** Accessible name of the group. */
    label: string;
    /** Rows (the default) or one line with the options side by side. */
    inline?: boolean;
    disabled?: boolean;
  }>(),
  { inline: false, disabled: false },
);

const model = defineModel<string>({ default: "" });
const name = useId();
</script>

<template>
  <div
    role="radiogroup"
    :aria-label="props.label"
    class="flex gap-2"
    :class="props.inline ? 'flex-row flex-wrap gap-x-6' : 'flex-col'"
  >
    <label
      v-for="option in props.options"
      :key="option.value"
      class="inline-flex items-center gap-2 text-md select-none"
      :class="props.disabled ? 'text-fg-disabled' : 'text-fg'"
      :data-testid="`radio-${option.value}`"
    >
      <input
        v-model="model"
        type="radio"
        :name="name"
        :value="option.value"
        :disabled="props.disabled"
        :aria-describedby="option.hint ? `${name}-${option.value}-hint` : undefined"
        class="peer sr-only"
      />
      <span
        aria-hidden="true"
        class="radio-box flex shrink-0 items-center justify-center rounded-sm border peer-focus-visible:outline-2 peer-focus-visible:outline-focus"
        :class="
          model === option.value
            ? props.disabled
              ? 'border-fg-disabled bg-fg-disabled text-app'
              : 'border-fg bg-fg text-app'
            : props.disabled
              ? 'border-line bg-app'
              : 'border-line-strong bg-app'
        "
      >
        <Check v-if="model === option.value" :size="12" :stroke-width="2" />
      </span>
      <span>{{ option.label }}</span>
      <span v-if="option.hint" :id="`${name}-${option.value}-hint`" class="ml-2 text-fg-muted">
        {{ option.hint }}
      </span>
    </label>
  </div>
</template>

<style scoped>
/* The box is 14px; no spacing step is 14. */
.radio-box {
  width: 14px;
  height: 14px;
}
</style>
