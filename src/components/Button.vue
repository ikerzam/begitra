<script setup lang="ts">
import type { Component } from "vue";

import type { ButtonVariant, ControlSize } from "./types";

const props = withDefaults(
  defineProps<{
    /** Primary is the one filled button of a screen; secondary is outlined; ghost is bare. */
    variant?: ButtonVariant;
    size?: ControlSize;
    icon?: Component;
    type?: "button" | "submit" | "reset";
    disabled?: boolean;
  }>(),
  { variant: "secondary", size: "md", icon: undefined, type: "button", disabled: false },
);

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-fg text-app enabled:hover:bg-btn-primary-hover enabled:active:bg-btn-primary-active disabled:bg-selected disabled:text-fg-disabled",
  secondary:
    "border border-line-strong text-fg enabled:hover:bg-hover enabled:active:bg-active disabled:border-line disabled:text-fg-disabled",
  ghost:
    "text-fg-secondary enabled:hover:bg-hover enabled:hover:text-fg enabled:active:bg-active disabled:text-fg-disabled",
  // A destructive action that is not the dialog's primary ("Delete project…").
  "ghost-danger":
    "text-danger enabled:hover:bg-hover enabled:active:bg-active disabled:text-fg-disabled",
  destructive:
    "bg-danger text-white enabled:hover:bg-danger-hover enabled:active:bg-danger-active disabled:bg-selected disabled:text-fg-disabled",
};

const sizeClasses: Record<ControlSize, string> = { md: "h-control", lg: "h-6" };
</script>

<template>
  <button
    :type="props.type"
    :disabled="props.disabled"
    :data-variant="props.variant"
    class="inline-flex shrink-0 items-center justify-center gap-2 rounded-md px-3 text-md font-medium whitespace-nowrap select-none"
    :class="[variantClasses[props.variant], sizeClasses[props.size]]"
  >
    <component
      :is="props.icon"
      v-if="props.icon"
      :size="16"
      :stroke-width="1.5"
      aria-hidden="true"
      class="shrink-0"
    />
    <slot />
  </button>
</template>
