<script setup lang="ts">
// The settings' About section: the version, the log file with "Open logs folder",
// and the update check: nothing runs until the control is pressed; the version found offers
// "Download and install" (the progress in the status bar), then "Restart".

import { FolderOpen, RefreshCw } from "@lucide/vue";
import { computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import { useSettingsScreenStore } from "@/stores/settingsScreen";
import { useUpdaterStore } from "@/stores/updater";

import SettingsField from "./SettingsField.vue";
import SettingsSection from "./SettingsSection.vue";

const { t } = useI18n();
const screen = useSettingsScreenStore();
const updater = useUpdaterStore();

const busy = computed(
  () => updater.state.kind === "checking" || updater.state.kind === "downloading",
);
/** The sentence beside the control, per state; none while idle. */
const status = computed(() => {
  const state = updater.state;
  switch (state.kind) {
    case "checking":
      return t("settings.about.checking");
    case "upToDate":
      return t("settings.about.upToDate");
    case "available":
      return t("settings.about.available", { version: state.version });
    case "downloading":
      return t("settings.about.downloading", { version: state.version });
    case "installed":
      return t("settings.about.installed", { version: state.version });
    default:
      return "";
  }
});

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
    <SettingsField
      :label="t('settings.about.updates')"
      :hint="t('settings.about.endpointHint')"
      wide
    >
      <div class="flex flex-col gap-3">
        <div class="flex items-center gap-3">
          <Button
            v-if="updater.state.kind === 'available'"
            variant="primary"
            data-testid="update-install"
            @click="() => void updater.install()"
          >
            {{ t("settings.about.downloadInstall") }}
          </Button>
          <Button
            v-else-if="updater.state.kind === 'installed'"
            variant="primary"
            data-testid="update-restart"
            @click="() => void updater.restart()"
          >
            {{ t("settings.about.restart") }}
          </Button>
          <Button
            v-else
            variant="secondary"
            :icon="RefreshCw"
            :disabled="busy"
            data-testid="update-check"
            @click="() => void updater.check()"
          >
            {{ t("settings.about.check") }}
          </Button>
          <span
            v-if="status"
            class="text-md text-fg-secondary"
            role="status"
            data-testid="update-status"
          >
            {{ status }}
          </span>
        </div>
        <ErrorBanner
          v-if="updater.state.kind === 'failed'"
          :message="t('settings.about.failed', { message: updater.state.error.message })"
          :action="t('settings.about.check')"
          data-testid="update-failed"
          @action="() => void updater.check()"
        />
      </div>
    </SettingsField>
  </SettingsSection>
</template>
