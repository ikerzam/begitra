<script setup lang="ts">
// A titled group of settings fields (Discovery, Git, Terminal and
// editor, Diff, Shortcuts), separated from the next by a hairline.

const props = defineProps<{ title: string }>();
</script>

<template>
  <section class="flex flex-col gap-3" :aria-label="props.title" data-testid="settings-section">
    <h2 class="text-lg font-semibold text-fg">{{ props.title }}</h2>
    <slot />
  </section>
</template>
