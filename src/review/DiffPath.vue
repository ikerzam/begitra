<script setup lang="ts">
// A file's path in a diff header: the folder truncates first, so the file name stays whole
// while the header's controls take their room; the whole path is its tooltip.

import { computed } from "vue";

const props = defineProps<{ path: string }>();

const parts = computed(() => {
  const at = props.path.lastIndexOf("/");
  return at < 0
    ? { folder: "", name: props.path }
    : { folder: props.path.slice(0, at + 1), name: props.path.slice(at + 1) };
});
</script>

<template>
  <span
    class="flex min-w-0 font-mono text-mono-sm text-fg-secondary select-text"
    :data-tooltip="props.path"
  >
    <span v-if="parts.folder" class="min-w-0 truncate">{{ parts.folder }}</span>
    <span class="max-w-full shrink-0 truncate">{{ parts.name }}</span>
  </span>
</template>
