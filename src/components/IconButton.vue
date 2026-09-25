<script setup lang="ts">
import { computed, type Component } from "vue";
import { useI18n } from "vue-i18n";

const props = withDefaults(
  defineProps<{
    /** Accessible name, also shown as the app's tooltip. */
    label: string;
    icon?: Component;
    /** For toggle buttons (layout modes, rail tabs): renders `aria-pressed` and the selected fill. */
    pressed?: boolean;
    disabled?: boolean;
    /** 24px square by default; `lg` is the 32px hit area of the sidebar rail. */
    size?: "md" | "lg";
    /** The tooltip's text where it differs from the accessible name; the label by default. */
    tooltip?: string;
    /** A shortcut hint shown as `kbd` in the tooltip after its text. */
    keys?: string;
    /** A number shown after the icon (a toggle's count), which widens the button; none at 0. */
    count?: number;
  }>(),
  {
    icon: undefined,
    pressed: undefined,
    disabled: false,
    size: "md",
    tooltip: undefined,
    keys: "",
    count: 0,
  },
);

const { n } = useI18n();

/** Formatted in the locale; past three digits the exact number stops mattering. */
const countText = computed(() => (props.count > 999 ? `${n(999)}+` : n(props.count)));
</script>

<template>
  <button
    type="button"
    :disabled="props.disabled"
    :aria-label="props.label"
    :aria-pressed="props.pressed"
    :data-tooltip="props.tooltip ?? props.label"
    :data-tooltip-keys="props.keys || undefined"
    class="inline-flex shrink-0 items-center justify-center rounded-sm enabled:active:bg-active disabled:text-fg-disabled"
    :class="[
      props.count > 0 ? 'h-5 min-w-5 gap-1 px-1' : props.size === 'lg' ? 'size-6' : 'size-5',
      // A pressed toggle keeps its fill under the pointer instead of turning into a hover.
      props.pressed
        ? 'bg-selected text-fg'
        : 'text-fg-secondary enabled:hover:bg-hover enabled:hover:text-fg',
    ]"
  >
    <component
      :is="props.icon"
      v-if="props.icon"
      :size="16"
      :stroke-width="1.5"
      aria-hidden="true"
    />
    <span v-if="props.count > 0" class="text-sm tabular-nums" data-testid="icon-button-count">
      {{ countText }}
    </span>
    <slot />
  </button>
</template>
