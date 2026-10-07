<script setup lang="ts">
import { computed, useAttrs, useId } from "vue";
import type { Component } from "vue";

import type { ControlSize } from "./types";

const props = withDefaults(
  defineProps<{
    placeholder?: string;
    icon?: Component;
    /** Validation message shown under the field in `--danger`; also sets `aria-invalid`. */
    error?: string;
    disabled?: boolean;
    size?: ControlSize;
    type?: string;
    /** The error treatment (red border, `aria-invalid`) with the sentence shown elsewhere. */
    invalid?: boolean;
  }>(),
  {
    placeholder: "",
    icon: undefined,
    error: "",
    disabled: false,
    size: "md",
    type: "text",
    invalid: false,
  },
);

const model = defineModel<string>({ default: "" });

/* Attributes such as `name` belong on the input element, not on the wrapper. */
defineOptions({ inheritAttrs: false });

const id = useId();
const attrs = useAttrs();
const errorId = `${id}-error`;
const hasError = computed(() => props.error !== "");
const invalid = computed(() => hasError.value || props.invalid);
/** The description the caller names (a settings hint) and the error under the field. */
const describedBy = computed(() => {
  const named = attrs["aria-describedby"];
  const ids = [typeof named === "string" ? named : "", hasError.value ? errorId : ""];
  const joined = ids.filter((part) => part !== "").join(" ");
  return joined === "" ? undefined : joined;
});
</script>

<template>
  <div class="flex w-full flex-col gap-1">
    <div class="relative flex items-center">
      <component
        :is="props.icon"
        v-if="props.icon"
        :size="16"
        :stroke-width="1.5"
        aria-hidden="true"
        class="pointer-events-none absolute left-2 text-fg-muted"
      />
      <input
        :id="id"
        v-model="model"
        v-bind="$attrs"
        :type="props.type"
        :placeholder="props.placeholder"
        :disabled="props.disabled"
        :aria-invalid="invalid ? 'true' : undefined"
        :aria-describedby="describedBy"
        class="w-full rounded-sm border bg-app pr-3 text-md text-fg placeholder:text-fg-muted disabled:border-line disabled:text-fg-disabled disabled:placeholder:text-fg-disabled"
        :class="[
          invalid ? 'border-danger' : 'border-line-strong',
          props.icon ? 'pl-6' : 'pl-3',
          props.size === 'lg' ? 'h-6' : 'h-control',
        ]"
      />
    </div>
    <p v-if="hasError" :id="errorId" class="text-sm text-danger">{{ props.error }}</p>
  </div>
</template>
