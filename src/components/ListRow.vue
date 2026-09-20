<script setup lang="ts">
import { CircleAlert } from "@lucide/vue";
import { computed } from "vue";
import type { Component } from "vue";

import AheadBehind from "./AheadBehind.vue";
import DirtyDot from "./DirtyDot.vue";
import LaneDot from "./LaneDot.vue";

const props = withDefaults(
  defineProps<{
    name: string;
    /** Lane colour of a branch; 0 shows the icon instead, when there is one. */
    lane?: number;
    icon?: Component;
    dirty?: boolean;
    ahead?: number;
    behind?: number;
    /** Trailing muted text, such as a count. */
    meta?: string;
    /** The folder is gone: the alert icon and the meta in the danger colour. */
    missing?: boolean;
    selected?: boolean;
    /** Roving tab stop; defaults to the selected row. Lists without a selection pass it to the first row. */
    tabStop?: boolean;
    /** Draw the icon after the lane dot too (the Worktrees tab shows both). */
    iconBeside?: boolean;
  }>(),
  {
    lane: 0,
    icon: undefined,
    dirty: false,
    ahead: undefined,
    behind: undefined,
    meta: "",
    missing: false,
    selected: false,
    tabStop: undefined,
    iconBeside: false,
  },
);

const emit = defineEmits<{ select: []; activate: [] }>();

const hasCounts = computed(() => props.ahead !== undefined || props.behind !== undefined);

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
    :tabindex="(props.tabStop ?? props.selected) ? 0 : -1"
    data-testid="list-row"
    class="flex h-row-list items-center gap-2 border-l-2 px-3 text-md whitespace-nowrap"
    :class="props.selected ? 'border-accent bg-selected' : 'border-transparent hover:bg-hover'"
    @click="emit('select')"
    @dblclick="emit('activate')"
    @keydown="onKeydown"
  >
    <CircleAlert
      v-if="props.missing"
      :size="16"
      :stroke-width="1.5"
      aria-hidden="true"
      class="shrink-0 text-danger"
      data-testid="list-row-missing"
    />
    <LaneDot v-else-if="props.lane > 0" :lane="props.lane" />
    <component
      :is="props.icon"
      v-if="props.icon && !props.missing && (props.lane === 0 || props.iconBeside)"
      :size="16"
      :stroke-width="1.5"
      aria-hidden="true"
      class="shrink-0"
      :class="props.selected ? 'text-fg' : 'text-fg-secondary'"
    />
    <span
      class="flex-1 truncate text-fg"
      :class="{ 'font-medium': props.selected }"
      data-testid="list-row-name"
    >
      {{ props.name }}
    </span>
    <DirtyDot v-if="props.dirty" />
    <AheadBehind v-if="hasCounts" :ahead="props.ahead ?? 0" :behind="props.behind ?? 0" />
    <span
      v-if="props.meta"
      class="shrink-0 text-sm"
      :class="props.missing ? 'text-danger' : 'text-fg-muted'"
      data-testid="list-row-meta"
    >
      {{ props.meta }}
    </span>
  </div>
</template>
