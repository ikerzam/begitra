<script setup lang="ts">
// The settings screen, beside the shell's rail: the
// title and the subtitle, then two columns, the sections Discovery, Git, Terminal and
// editor and Diff on the left, Shortcuts on the right. Every control writes the settings
// store at once; j/k move between the fields when no text field has the focus.

import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import Input from "@/components/Input.vue";
import { isEditableTarget } from "@/shortcuts/registry";
import { useSettingsStore } from "@/stores/settings";
import { useSettingsScreenStore } from "@/stores/settingsScreen";

import CommandsSettings from "./CommandsSettings.vue";
import DiffSettings from "./DiffSettings.vue";
import GitField from "./GitField.vue";
import ScanFoldersField from "./ScanFoldersField.vue";
import SettingsField from "./SettingsField.vue";
import AboutSettings from "./AboutSettings.vue";
import AppearanceSettings from "./AppearanceSettings.vue";
import SettingsSection from "./SettingsSection.vue";
import ShortcutsPanel from "./ShortcutsPanel.vue";
import { useCommittedText } from "./useCommittedText";

const { t } = useI18n();
const settings = useSettingsStore();
const screen = useSettingsScreenStore();
const page = ref<HTMLElement | null>(null);

const skipFolders = useCommittedText(
  () => settings.values.skipFolders.join(", "),
  (value) =>
    settings.update(
      "skipFolders",
      value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
);
const maxDepth = useCommittedText(
  () => String(settings.values.maxDepth),
  (value) => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return false;
    return settings.update("maxDepth", Math.min(32, Math.max(0, parsed)));
  },
);

// The screen shows the version of the git in use: PATH's git is probed when nothing
// is configured (the launch probes a configured one).
onMounted(() => {
  if (screen.gitState === "idle") void screen.probe();
});

/** j/k walk the page's controls when no text field has the focus ("j/k fields"). */
function onKeydown(event: KeyboardEvent): void {
  if (screen.capturing || isEditableTarget(event.target as HTMLElement | null)) return;
  if (event.key !== "j" && event.key !== "k") return;
  const controls = [
    ...(page.value?.querySelectorAll<HTMLElement>("input, select, button") ?? []),
  ].filter((control) => !control.hasAttribute("disabled"));
  if (controls.length === 0) return;
  const active = document.activeElement;
  const current = controls.findIndex((control) => control === active);
  const next = event.key === "j" ? current + 1 : current - 1;
  const target = controls[Math.min(Math.max(next, 0), controls.length - 1)];
  event.preventDefault();
  target?.focus();
}

defineExpose({
  /** "Add folder" first (the first control in DOM order can be a folder's remove button). */
  focus: () => {
    const add = page.value?.querySelector<HTMLElement>('[data-testid="scan-folders-add"]');
    (add ?? page.value?.querySelector<HTMLElement>("input, select, button"))?.focus();
  },
});
</script>

<template>
  <div
    ref="page"
    class="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-6 pt-5"
    data-testid="settings-layout"
    @keydown="onKeydown"
  >
    <header class="flex flex-col gap-1">
      <h1 class="text-xl font-semibold text-fg">{{ t("settings.title") }}</h1>
      <p class="text-sm text-fg-muted">{{ t("settings.subtitle") }}</p>
    </header>
    <div class="settings-columns grid">
      <div class="flex flex-col gap-4">
        <AppearanceSettings />
        <hr class="border-line" />
        <SettingsSection :title="t('settings.discovery.title')">
          <ScanFoldersField />
          <SettingsField
            :label="t('settings.discovery.skipFolders')"
            for="settings-skip-folders"
            :hint="t('settings.discovery.skipFoldersHint')"
          >
            <Input
              id="settings-skip-folders"
              v-model="skipFolders.draft.value"
              data-testid="skip-folders"
              @blur="skipFolders.commit"
              @keydown="skipFolders.onKeydown"
            />
          </SettingsField>
          <SettingsField
            :label="t('settings.discovery.maxDepth')"
            for="settings-max-depth"
            :hint="t('settings.discovery.maxDepthHint')"
          >
            <div class="settings-depth">
              <Input
                id="settings-max-depth"
                v-model="maxDepth.draft.value"
                inputmode="numeric"
                data-testid="max-depth"
                @blur="maxDepth.commit"
                @keydown="maxDepth.onKeydown"
              />
            </div>
          </SettingsField>
        </SettingsSection>
        <hr class="border-line" />
        <SettingsSection :title="t('settings.git.title')">
          <GitField />
        </SettingsSection>
        <hr class="border-line" />
        <CommandsSettings />
        <hr class="border-line" />
        <DiffSettings />
        <hr class="border-line" />
        <AboutSettings />
        <hr class="border-line" />
      </div>
      <ShortcutsPanel />
    </div>
  </div>
</template>

<style scoped>
/* The right column 440px wide and 48px from the left one; the depth
   field 72px. Off the spacing scale. */
.settings-columns {
  grid-template-columns: minmax(0, 1fr) 440px;
  column-gap: 48px;
}
.settings-depth {
  width: 72px;
}
</style>
