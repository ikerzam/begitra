<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    label?: string;
    selected?: boolean;
    /** Id of the tab panel this tab controls. */
    controls?: string;
  }>(),
  { label: "", selected: false, controls: undefined },
);

const emit = defineEmits<{ select: [] }>();
</script>

<template>
  <button
    type="button"
    role="tab"
    :aria-selected="props.selected"
    :aria-controls="props.controls"
    class="inline-flex h-panel-header shrink-0 items-center border-b-2 px-3 text-md font-medium whitespace-nowrap"
    :class="
      props.selected ? 'border-fg text-fg' : 'border-transparent text-fg-secondary hover:text-fg'
    "
    @click="emit('select')"
  >
    <slot>{{ props.label }}</slot>
  </button>
</template>
