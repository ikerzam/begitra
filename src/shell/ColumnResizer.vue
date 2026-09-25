<script setup lang="ts">
// A column edge in a table header (the home table, the worktrees dashboard): the panes'
// divider placed on the header cell's right edge, in the middle of the 16px gap to the next
// column, so a column drags, steps with the arrow keys and resets like a pane.

import PaneResizer from "./PaneResizer.vue";

const props = defineProps<{ size: number; label: string; min: number; max: number }>();
const emit = defineEmits<{ resize: [px: number]; reset: [] }>();
</script>

<template>
  <div class="column-resizer absolute top-0 bottom-0 flex">
    <PaneResizer
      :size="props.size"
      :label="props.label"
      :min="props.min"
      :max="props.max"
      data-testid="column-resizer"
      @resize="(px) => emit('resize', px)"
      @reset="emit('reset')"
    />
  </div>
</template>

<style scoped>
/* Half the row's 16px gap past the cell: the edge sits between the two columns. */
.column-resizer {
  right: -8px;
}
</style>
