<script setup lang="ts">
const props = withDefaults(defineProps<{ keys?: string }>(), { keys: "" });
</script>

<template>
  <kbd
    class="inline-flex shrink-0 items-center rounded-sm bg-hover px-1 py-px font-ui text-sm whitespace-nowrap text-fg-secondary"
  >
    <slot>{{ props.keys }}</slot>
  </kbd>
</template>
