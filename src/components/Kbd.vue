<script setup lang="ts">
const props = withDefaults(defineProps<{ keys?: string }>(), { keys: "" });
</script>

<template>
  <kbd
    class="kbd inline-flex shrink-0 items-center justify-center rounded-sm bg-selected px-1 font-ui text-sm whitespace-nowrap text-fg-secondary"
  >
    <slot>{{ props.keys }}</slot>
  </kbd>
</template>

<style scoped>
/* 18px tall with a square minimum, like the badge. */
.kbd {
  height: 18px;
  min-width: 18px;
}
</style>
