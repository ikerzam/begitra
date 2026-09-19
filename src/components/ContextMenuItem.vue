<script setup lang="ts">
import { computed } from "vue";
import type { Component } from "vue";

import Kbd from "./Kbd.vue";

const props = withDefaults(
  defineProps<{
    label: string;
    icon?: Component;
    /** Muted text before the shortcut, such as a branch's last commit in the palette. */
    context?: string;
    keys?: string;
    destructive?: boolean;
    disabled?: boolean;
  }>(),
  { icon: undefined, context: "", keys: "", destructive: false, disabled: false },
);

const emit = defineEmits<{ select: [] }>();

const itemClass = computed(() => {
  if (props.disabled) return "text-fg-disabled";
  return props.destructive ? "text-danger hover:bg-hover" : "text-fg hover:bg-hover";
});

const iconClass = computed(() =>
  props.destructive && !props.disabled ? "text-danger" : "text-fg-secondary",
);

function onClick(): void {
  if (!props.disabled) emit("select");
}
</script>

<template>
  <button
    type="button"
    role="menuitem"
    tabindex="-1"
    :aria-disabled="props.disabled ? 'true' : undefined"
    :data-destructive="props.destructive ? 'true' : undefined"
    class="flex h-control w-full shrink-0 items-center gap-2 rounded-sm px-2 text-left text-md whitespace-nowrap focus:bg-selected"
    :class="itemClass"
    @click="onClick"
  >
    <component
      :is="props.icon"
      v-if="props.icon"
      :size="16"
      :stroke-width="1.5"
      aria-hidden="true"
      class="shrink-0"
      :class="iconClass"
    />
    <span class="flex-1 truncate">{{ props.label }}</span>
    <span v-if="props.context" class="truncate text-fg-muted">{{ props.context }}</span>
    <Kbd v-if="props.keys" :keys="props.keys" />
  </button>
</template>
