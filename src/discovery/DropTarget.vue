<script setup lang="ts">
// The drop target over the main area while a folder is dragged over the window: a dashed
// outline in --border-strong with one sentence.

import { useI18n } from "vue-i18n";

const props = defineProps<{ active: boolean }>();

const { t } = useI18n();
</script>

<template>
  <div
    v-if="props.active"
    class="pointer-events-none absolute inset-0 z-30 flex p-2"
    data-testid="drop-target"
  >
    <div
      class="flex flex-1 items-center justify-center rounded-lg border-2 border-dashed border-line-strong bg-app text-md text-fg"
    >
      {{ t("home.dropHere") }}
    </div>
  </div>
</template>
