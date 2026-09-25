<script setup lang="ts">
import { useI18n } from "vue-i18n";

const props = withDefaults(
  defineProps<{
    title: string;
    count?: number;
    /** A path as the title, in the code-sm role (the folder view's folder). */
    mono?: boolean;
    /** The title's tooltip, such as the whole of a path the title shortens. */
    tooltip?: string;
  }>(),
  { count: undefined, mono: false, tooltip: undefined },
);

const { n } = useI18n();
</script>

<template>
  <header
    data-testid="panel-header"
    class="flex h-panel-header shrink-0 items-center gap-2 border-b border-line px-3 text-md whitespace-nowrap"
  >
    <h2
      class="truncate text-fg"
      :class="props.mono ? 'font-mono text-mono-sm' : 'font-medium'"
      :data-tooltip="props.tooltip"
      data-testid="panel-header-title"
    >
      {{ props.title }}
    </h2>
    <span
      v-if="props.count !== undefined"
      class="text-sm text-fg-muted"
      data-testid="panel-header-count"
    >
      {{ n(props.count) }}
    </span>
    <!-- Extra text after the title, such as the commit hash of the detail panel. -->
    <slot />
    <!-- At most two icon actions, per the design; 24px buttons on a 32px pitch. -->
    <div
      v-if="$slots.actions"
      class="ml-auto flex items-center gap-2"
      data-testid="panel-header-actions"
    >
      <slot name="actions" />
    </div>
  </header>
</template>
