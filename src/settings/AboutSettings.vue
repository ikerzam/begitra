<script setup lang="ts">
// The settings' About section: the mark with the version, the log file with "Open logs folder",
// and the update check: nothing runs until the control is pressed; the version found offers
// "Download and install" (the progress in the status bar), then "Restart". One button
// element carries every state, so the focus stays on it while the check or the download runs
// (`aria-busy`, never `disabled`: a disabled control lets the focus go).

import { FolderOpen, RefreshCw } from "@lucide/vue";
import { computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";

import BrandMark from "@/components/BrandMark.vue";
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

/** The one control's label, variant and action, per state. */
const control = computed(() => {
  switch (updater.state.kind) {
    case "available":
    case "downloading":
      return { label: t("settings.about.downloadInstall"), primary: true, run: updater.install };
    case "installed":
      return { label: t("settings.about.restart"), primary: true, run: updater.restart };
    default:
      return { label: t("settings.about.check"), primary: false, run: updater.check };
  }
});

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

const version = computed(() => {
  switch (screen.appInfoState) {
    case "loaded":
      return t("settings.about.versionLine", { version: screen.appInfo?.version ?? "" });
    case "failed":
      return t("settings.about.versionUnavailable");
    default:
      return "";
  }
});

function press(): void {
  if (busy.value) return;
  void control.value.run();
}

onMounted(() => {
  if (screen.appInfoState === "pending") void screen.loadAppInfo();
});
</script>

<template>
  <SettingsSection :title="t('settings.about.title')">
    <SettingsField :label="t('settings.about.version')">
      <div class="flex items-center gap-2">
        <BrandMark class="size-5" />
        <p class="text-md text-fg" data-testid="about-version">{{ version }}</p>
      </div>
    </SettingsField>
    <SettingsField :label="t('settings.about.logs')" :hint="t('settings.about.logsHint')" wide>
      <div class="flex items-center gap-3">
        <span
          v-if="screen.appInfo?.logFile"
          class="min-w-0 truncate font-mono text-mono-sm text-fg-secondary"
          :title="screen.appInfo.logFile"
          data-testid="about-log-file"
        >
          {{ screen.appInfo.logFile }}
        </span>
        <span
          v-else-if="screen.appInfoState === 'loaded'"
          class="text-md text-fg-muted"
          data-testid="about-no-log"
        >
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
            :variant="control.primary ? 'primary' : 'secondary'"
            :icon="control.primary ? undefined : RefreshCw"
            :aria-busy="busy ? 'true' : undefined"
            :aria-disabled="busy ? 'true' : undefined"
            data-testid="update-control"
            @click="press"
          >
            {{ control.label }}
          </Button>
          <span class="text-md text-fg-secondary" role="status" data-testid="update-status">
            {{ status }}
          </span>
        </div>
        <ErrorBanner
          v-if="updater.state.kind === 'failed'"
          :message="t('settings.about.failed')"
          :output="updater.state.error.detail ?? updater.state.error.message"
          :output-label="t('settings.about.showDetails')"
          data-testid="update-failed"
        />
      </div>
    </SettingsField>
  </SettingsSection>
</template>
