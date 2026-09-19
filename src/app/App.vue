<script setup lang="ts">
// Root: loads the settings (falling back to memory outside Tauri), applies the locale, then
// renders the shell.

import { onMounted, ref } from "vue";

import { setLocale } from "@/i18n";
import AppShell from "@/shell/AppShell.vue";
import { memoryStorage, tauriStorage, useSettingsStore } from "@/stores/settings";

const settings = useSettingsStore();
const ready = ref(false);

onMounted(async () => {
  try {
    await settings.init(await tauriStorage());
  } catch {
    await settings.init(memoryStorage());
  }
  setLocale(settings.values.locale);
  ready.value = true;
});
</script>

<template>
  <div class="h-full bg-app text-fg" data-testid="app-root">
    <AppShell v-if="ready" />
  </div>
</template>
