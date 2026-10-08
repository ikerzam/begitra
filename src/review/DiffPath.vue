<script setup lang="ts">
// A file's path in a diff header or a note: the folder truncates first, so the file name stays
// whole while the controls beside it take their room; the whole path is its tooltip. `muted`
// dims it, for a note an agent resolved.

import { computed } from "vue";

const props = defineProps<{ path: string; muted?: boolean }>();

const parts = computed(() => {
  const at = props.path.lastIndexOf("/");
  return at < 0
    ? { folder: "", name: props.path }
    : { folder: props.path.slice(0, at + 1), name: props.path.slice(at + 1) };
});
</script>

<template>
  <span
    class="flex min-w-0 font-mono text-mono-sm select-text"
    :class="props.muted ? 'text-fg-muted' : 'text-fg-secondary'"
    :data-tooltip="props.path"
  >
    <span v-if="parts.folder" class="min-w-0 truncate">{{ parts.folder }}</span>
    <span class="max-w-full shrink-0 truncate">{{ parts.name }}</span>
  </span>
</template>
