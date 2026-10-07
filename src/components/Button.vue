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
    /**
     * Why the button cannot act now. It stays in the tab order and under the pointer
     * (`aria-disabled`), its tooltip and description say why, and a press does nothing.
     */
    unavailable?: string;
    /** The app's tooltip, when the label does not say it all. */
    tooltip?: string;
    /** A shortcut hint shown as `kbd` in the tooltip after its text. */
    keys?: string;
  }>(),
  {
    variant: "secondary",
    size: "md",
    icon: undefined,
    type: "button",
    disabled: false,
    unavailable: "",
    tooltip: "",
    keys: "",
  },
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

/** An unavailable button looks as a disabled one does, with no hover or press. */
const unavailableClasses: Record<ButtonVariant, string> = {
  primary: "bg-selected text-fg-disabled",
  secondary: "border border-line text-fg-disabled",
  ghost: "text-fg-disabled",
  "ghost-danger": "text-fg-disabled",
  destructive: "bg-selected text-fg-disabled",
};

const sizeClasses: Record<ControlSize, string> = { md: "h-control", lg: "h-6" };

/** An unavailable button's press reaches no listener, the parent's or a form's included. */
function onClick(event: MouseEvent): void {
  if (!props.unavailable) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}
</script>

<template>
  <button
    :type="props.type"
    :disabled="props.disabled"
    :aria-disabled="props.unavailable ? 'true' : undefined"
    :data-tooltip="props.unavailable || props.tooltip || undefined"
    :data-tooltip-keys="props.keys || undefined"
    :aria-description="props.unavailable || props.keys || undefined"
    :data-variant="props.variant"
    class="inline-flex shrink-0 items-center justify-center gap-2 rounded-md px-3 text-md font-medium whitespace-nowrap select-none"
    :class="[
      props.unavailable ? unavailableClasses[props.variant] : variantClasses[props.variant],
      sizeClasses[props.size],
    ]"
    @click="onClick"
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
