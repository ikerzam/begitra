<script setup lang="ts">
// The home header: the title, the count sentence and
// "Open folder…".

import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";

import { useDiscoveryFormat } from "./useDiscoveryFormat";

const emit = defineEmits<{ openFolder: [] }>();

const { t } = useI18n();
const format = useDiscoveryFormat();
</script>

<template>
  <header class="flex items-start justify-between gap-4 px-5 pt-5" data-testid="home-header">
    <div class="min-w-0">
      <h1 class="text-lg font-medium text-fg">{{ t("home.title") }}</h1>
      <p class="text-md text-fg-muted" data-testid="home-summary">{{ format.summary.value }}</p>
    </div>
    <Button variant="secondary" data-testid="home-open-folder" @click="emit('openFolder')">
      {{ t("home.openFolder") }}
    </Button>
  </header>
</template>
