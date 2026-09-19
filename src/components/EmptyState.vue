<script setup lang="ts">
const props = defineProps<{
  /** One sentence; the action, when there is one, comes through the slot. */
  message: string;
}>();
</script>

<template>
  <div
    data-testid="empty-state"
    class="flex flex-col items-center justify-center gap-5 p-6 text-center"
  >
    <p class="text-md text-fg-secondary">{{ props.message }}</p>
    <div v-if="$slots.default" class="flex items-center gap-2">
      <slot />
    </div>
  </div>
</template>
