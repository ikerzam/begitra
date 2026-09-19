<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    /** Commit subject; clips, never wraps. */
    message: string;
    author?: string;
    /** Relative date, already formatted ("2h ago"). */
    date?: string;
    /** Short hash in mono. */
    hash?: string;
    selected?: boolean;
  }>(),
  { author: "", date: "", hash: "", selected: false },
);

/** `select` on click; `activate` on double click or Enter. Arrow and j/k moves belong to the list. */
const emit = defineEmits<{ select: []; activate: [] }>();

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter") {
    event.preventDefault();
    emit("activate");
  }
}
</script>

<template>
  <div
    role="option"
    :aria-selected="props.selected"
    :tabindex="props.selected ? 0 : -1"
    data-testid="graph-row"
    class="flex h-row-graph items-center border-l-2 pr-3 text-md whitespace-nowrap"
    :class="[
      props.selected ? 'border-accent bg-selected' : 'border-transparent hover:bg-hover',
      { 'pl-3': !$slots.lanes },
    ]"
    @click="emit('select')"
    @dblclick="emit('activate')"
    @keydown="onKeydown"
  >
    <div
      v-if="$slots.lanes"
      class="flex shrink-0 items-center self-stretch"
      data-testid="graph-row-lanes"
    >
      <slot name="lanes" />
    </div>
    <div
      v-if="$slots.refs"
      class="mr-2 flex shrink-0 items-center gap-2"
      data-testid="graph-row-refs"
    >
      <slot name="refs" />
    </div>
    <span class="flex-1 truncate text-fg" data-testid="graph-row-message">
      {{ props.message }}
    </span>
    <span
      class="graph-row-author ml-4 shrink-0 truncate text-sm text-fg-secondary"
      data-testid="graph-row-author"
    >
      {{ props.author }}
    </span>
    <span
      class="graph-row-date ml-4 shrink-0 text-right text-sm text-fg-muted"
      data-testid="graph-row-date"
    >
      {{ props.date }}
    </span>
    <span
      class="graph-row-hash ml-4 shrink-0 font-mono text-mono-sm text-fg-muted"
      data-testid="graph-row-hash"
    >
      {{ props.hash }}
    </span>
  </div>
</template>

<style scoped>
/* Fixed metadata columns keep the graph aligned. */
.graph-row-author {
  width: var(--graph-author-w, 96px);
}

.graph-row-date {
  width: var(--graph-date-w, 56px);
}

.graph-row-hash {
  width: var(--graph-hash-w, 56px);
}
</style>
