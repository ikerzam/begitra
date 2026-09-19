<script setup lang="ts">
import { useI18n } from "vue-i18n";

const props = withDefaults(
  defineProps<{
    title: string;
    count?: number;
  }>(),
  { count: undefined },
);

const { n } = useI18n();
</script>

<template>
  <header
    data-testid="panel-header"
    class="flex h-panel-header shrink-0 items-center gap-2 border-b border-line px-3 text-md whitespace-nowrap"
  >
    <h2 class="truncate font-medium text-fg" data-testid="panel-header-title">{{ props.title }}</h2>
    <span v-if="props.count !== undefined" class="text-fg-muted" data-testid="panel-header-count">
      {{ n(props.count) }}
    </span>
    <!-- At most two icon actions, per the design. -->
    <div
      v-if="$slots.actions"
      class="ml-auto flex items-center gap-1"
      data-testid="panel-header-actions"
    >
      <slot name="actions" />
    </div>
  </header>
</template>
