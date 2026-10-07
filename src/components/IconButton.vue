<script setup lang="ts">
import { computed, type Component } from "vue";
import { useI18n } from "vue-i18n";

const props = withDefaults(
  defineProps<{
    /** Accessible name, also shown as the app's tooltip. */
    label: string;
    icon?: Component;
    /** For toggle buttons (layout modes, the dashboard): renders `aria-pressed` and the selected fill. */
    pressed?: boolean;
    /**
     * For a button that shows and hides what it controls (the rail's panels): renders
     * `aria-expanded` and, while expanded, the selected fill.
     */
    expanded?: boolean;
    disabled?: boolean;
    /**
     * Why the button cannot act now. It stays in the tab order and under the pointer
     * (`aria-disabled`), its tooltip and description say why, and a press does nothing.
     */
    unavailable?: string;
    /** 24px square by default; `lg` is the 32px hit area of the sidebar rail. */
    size?: "md" | "lg";
    /** The tooltip's text where it differs from the accessible name; the label by default. */
    tooltip?: string;
    /** A shortcut hint shown as `kbd` in the tooltip after its text. */
    keys?: string;
    /** Read after the name by assistive technology (an alert the icon carries). */
    description?: string;
    /** A number shown after the icon (a toggle's count), which widens the button; none at 0. */
    count?: number;
  }>(),
  {
    icon: undefined,
    pressed: undefined,
    expanded: undefined,
    disabled: false,
    unavailable: "",
    size: "md",
    tooltip: undefined,
    keys: "",
    description: "",
    count: 0,
  },
);

const { n } = useI18n();

/** Formatted in the locale; past three digits the exact number stops mattering. */
const countText = computed(() => (props.count > 999 ? `${n(999)}+` : n(props.count)));

/* The colours by state: unavailable dims the icon (a pressed one keeps its fill); a pressed
   toggle, or an expanded disclosure, keeps its fill under the pointer instead of a hover. */
const selected = computed(() => props.pressed === true || props.expanded === true);
const stateClass = computed(() => {
  if (props.unavailable)
    return selected.value ? "bg-selected text-fg-disabled" : "text-fg-disabled";
  return selected.value
    ? "bg-selected text-fg"
    : "text-fg-secondary enabled:hover:bg-hover enabled:hover:text-fg";
});

/** An unavailable button's press reaches no listener, the parent's included. */
function onClick(event: MouseEvent): void {
  if (props.unavailable) event.stopImmediatePropagation();
}
</script>

<template>
  <button
    type="button"
    :disabled="props.disabled"
    :aria-disabled="props.unavailable ? 'true' : undefined"
    :aria-label="props.label"
    :aria-pressed="props.pressed"
    :aria-expanded="props.expanded"
    :data-tooltip="props.unavailable || (props.tooltip ?? props.label)"
    :data-tooltip-keys="props.keys || undefined"
    :aria-description="props.unavailable || props.description || props.keys || undefined"
    class="inline-flex shrink-0 items-center justify-center rounded-sm disabled:text-fg-disabled"
    :class="[
      props.count > 0 ? 'h-5 min-w-5 gap-1 px-1' : props.size === 'lg' ? 'size-6' : 'size-5',
      props.unavailable ? '' : 'enabled:active:bg-active',
      stateClass,
    ]"
    @click="onClick"
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
