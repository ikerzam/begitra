<script setup lang="ts">
/*
 * A tab carries no side padding, so the 2px underline spans its label only: the preflight zeroes
 * button padding and the strict spacing scale has no `px-0`. The bar that holds the tabs lays
 * them out with `gap-4` (16px apart).
 */
const props = withDefaults(
  defineProps<{
    label?: string;
    selected?: boolean;
    /** Id of the tab panel this tab controls. */
    controls?: string;
    /** As tall as the top bar (40px), for a view's header; the panel header's 32px otherwise. */
    tall?: boolean;
  }>(),
  { label: "", selected: false, controls: undefined, tall: false },
);

const emit = defineEmits<{ select: [] }>();
</script>

<template>
  <button
    type="button"
    role="tab"
    :aria-selected="props.selected"
    :aria-controls="props.controls"
    :tabindex="props.selected ? 0 : -1"
    class="inline-flex shrink-0 items-center border-b-2 text-md font-medium whitespace-nowrap"
    :class="[
      props.tall ? 'h-bar-top' : 'h-panel-header',
      props.selected ? 'border-fg text-fg' : 'border-transparent text-fg-secondary hover:text-fg',
    ]"
    @click="emit('select')"
  >
    <slot>{{ props.label }}</slot>
  </button>
</template>
