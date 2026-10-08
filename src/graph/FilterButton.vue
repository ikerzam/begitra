<script setup lang="ts">
// A filter of the graph's bar that opens a popover (Path, Code). At rest: its icon and name in
// `--text-secondary`, the name dropped below 840px of bar so that the selects keep their labels,
// the button then 28px square as the bar's toggles, its name in the tooltip. Active: filled with
// `--bg-selected` under the pointer too, the icon in `--text-secondary` and the value in `--text`,
// cut past 160px with the whole value in the tooltip.

import type { Component } from "vue";

const props = defineProps<{
  icon: Component;
  /** The filter's name, shown at rest. */
  label: string;
  /** The active filter's value; null at rest. */
  value: string | null;
  /** The accessible name while active; the value by default. */
  activeLabel?: string;
  /** The tooltip while active; the value by default. */
  activeTooltip?: string;
  /** Whether its popover is open. */
  expanded: boolean;
}>();
const emit = defineEmits<{ click: [] }>();
</script>

<template>
  <button
    type="button"
    class="filter-button inline-flex h-control shrink-0 items-center gap-2 rounded-md px-3 text-md font-medium whitespace-nowrap text-fg-secondary select-none"
    :class="
      props.value === null
        ? 'filter-at-rest hover:bg-hover hover:text-fg active:bg-active'
        : 'bg-selected'
    "
    :aria-label="props.value === null ? props.label : (props.activeLabel ?? props.value)"
    aria-haspopup="dialog"
    :aria-expanded="props.expanded"
    :data-tooltip="props.value === null ? props.label : (props.activeTooltip ?? props.value)"
    @click="emit('click')"
  >
    <component
      :is="props.icon"
      :size="16"
      :stroke-width="1.5"
      aria-hidden="true"
      class="shrink-0"
    />
    <span v-if="props.value === null" class="filter-name">{{ props.label }}</span>
    <span v-else class="filter-value truncate text-fg">{{ props.value }}</span>
  </button>
</template>

<style scoped>
/* The value is cut past 160px, the button's padding and icon aside; not on the spacing scale. */
.filter-value {
  max-width: 160px;
}

/* 840px is the bar's width at rest with every name shown (the docked sidebar at 1440 leaves it
   672); the 6px padding makes the 28px square of the bar's toggles around the 16px icon. */
@container filter-bar (width < 840px) {
  .filter-name {
    display: none;
  }

  .filter-at-rest {
    padding-inline: 6px;
  }
}
</style>
