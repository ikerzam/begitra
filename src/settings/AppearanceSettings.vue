<script setup lang="ts">
// The settings' Appearance section: the theme as three radios, applied at once.

import { computed } from "vue";
import { useI18n } from "vue-i18n";

import RadioGroup from "@/components/RadioGroup.vue";
import type { RadioOption } from "@/components/types";
import { useSettingsStore } from "@/stores/settings";

import SettingsField from "./SettingsField.vue";
import SettingsSection from "./SettingsSection.vue";

const { t } = useI18n();
const settings = useSettingsStore();

const themes = computed<RadioOption[]>(() =>
  (["system", "dark", "light"] as const).map((theme) => ({
    value: theme,
    label: t(`settings.appearance.themes.${theme}`),
  })),
);
const theme = computed({
  get: () => settings.values.theme,
  set: (value: string) => {
    if (value === "system" || value === "dark" || value === "light") {
      void settings.update("theme", value);
    }
  },
});
</script>

<template>
  <SettingsSection :title="t('settings.appearance.title')">
    <SettingsField :label="t('settings.appearance.theme')" :hint="t('settings.appearance.hint')">
      <RadioGroup
        v-model="theme"
        :options="themes"
        :label="t('settings.appearance.theme')"
        inline
        data-testid="theme"
      />
    </SettingsField>
  </SettingsSection>
</template>
