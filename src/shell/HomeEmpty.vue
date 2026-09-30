<script setup lang="ts">
// The empty Home: no project yet. "Open folder…" in the header opens a repository (a project of
// one) or a folder of repositories (its folder project); "Add a folder of repositories" makes
// the folder's project and scans it, whatever the folder lies in.

import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import EmptyState from "@/components/EmptyState.vue";

const emit = defineEmits<{ openFolder: []; addFolder: [] }>();
const { t } = useI18n();
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col" data-testid="home-empty">
    <header class="flex items-start justify-between gap-4 px-5 pt-5">
      <div>
        <h1 class="text-lg font-semibold text-fg">{{ t("home.title") }}</h1>
        <p class="text-md text-fg-muted">{{ t("home.subtitle") }}</p>
      </div>
      <Button variant="secondary" data-testid="home-open-folder" @click="emit('openFolder')">
        {{ t("home.openFolder") }}
      </Button>
    </header>
    <div class="flex flex-1 items-center justify-center">
      <EmptyState :message="t('home.empty')">
        <Button variant="secondary" data-testid="home-empty-add" @click="emit('addFolder')">
          {{ t("home.addFolderToScan") }}
        </Button>
      </EmptyState>
    </div>
  </section>
</template>
