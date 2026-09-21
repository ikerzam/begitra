<script setup lang="ts">
// The settings' About section: the version, the log file with "Open logs folder",
// each in its own field.

import { FolderOpen } from "@lucide/vue";
import { onMounted } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import { useSettingsScreenStore } from "@/stores/settingsScreen";

import SettingsField from "./SettingsField.vue";
import SettingsSection from "./SettingsSection.vue";

const { t } = useI18n();
const screen = useSettingsScreenStore();

onMounted(() => {
  if (!screen.appInfo) void screen.loadAppInfo();
});
</script>

<template>
  <SettingsSection :title="t('settings.about.title')">
    <SettingsField :label="t('settings.about.version')">
      <p class="text-md text-fg" data-testid="about-version">
        {{ t("settings.about.versionLine", { version: screen.appInfo?.version ?? "…" }) }}
      </p>
    </SettingsField>
    <SettingsField :label="t('settings.about.logs')" :hint="t('settings.about.logsHint')" wide>
      <div class="flex items-center gap-3">
        <span
          v-if="screen.appInfo?.logFile"
          class="min-w-0 truncate font-mono text-mono-sm text-fg-secondary"
          data-testid="about-log-file"
        >
          {{ screen.appInfo.logFile }}
        </span>
        <span v-else class="text-md text-fg-muted" data-testid="about-no-log">
          {{ t("settings.about.noLogFile") }}
        </span>
        <Button
          variant="secondary"
          :icon="FolderOpen"
          :disabled="!screen.appInfo?.logDir"
          class="shrink-0"
          data-testid="about-open-logs"
          @click="() => void screen.openLogsFolder()"
        >
          {{ t("settings.about.openLogs") }}
        </Button>
      </div>
    </SettingsField>
  </SettingsSection>
</template>
