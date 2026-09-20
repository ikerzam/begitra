<script setup lang="ts">
// A multi-line input in the treatment of `Input` (`--border-strong`, radius 4,
// `--bg-app`), for the notes of the review rail; it simply follows the
// single-line field.

import { useId } from "vue";

const props = withDefaults(
  defineProps<{
    placeholder?: string;
    disabled?: boolean;
    /** Visible rows. */
    rows?: number;
  }>(),
  { placeholder: "", disabled: false, rows: 3 },
);

const model = defineModel<string>({ default: "" });

defineOptions({ inheritAttrs: false });

const id = useId();
</script>

<template>
  <textarea
    :id="id"
    v-model="model"
    v-bind="$attrs"
    :placeholder="props.placeholder"
    :disabled="props.disabled"
    :rows="props.rows"
    class="w-full resize-y rounded-sm border border-line-strong bg-app px-3 py-1 text-md text-fg placeholder:text-fg-muted disabled:border-line disabled:text-fg-disabled"
  />
</template>
