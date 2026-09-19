<script setup lang="ts">
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import EmptyState from "@/components/EmptyState.vue";

const emit = defineEmits<{ openFolder: [] }>();
const { t } = useI18n();
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col" data-testid="home-empty">
    <header class="flex items-start justify-between gap-4 px-6 pt-4">
      <div>
        <h1 class="text-lg font-medium text-fg">{{ t("home.title") }}</h1>
        <p class="text-md text-fg-secondary">{{ t("home.subtitle") }}</p>
      </div>
      <Button variant="secondary" data-testid="home-open-folder" @click="emit('openFolder')">
        {{ t("home.openFolder") }}
      </Button>
    </header>
    <div class="flex flex-1 items-center justify-center">
      <EmptyState :message="t('home.empty')">
        <Button variant="primary" data-testid="home-empty-open" @click="emit('openFolder')">
          {{ t("home.openFolder") }}
        </Button>
      </EmptyState>
    </div>
  </section>
</template>
