<script setup lang="ts">
// The settings' Appearance section: the theme and the code theme as selects (Begitra's own
// dark and light, then the palettes by name), the zoom as a select, then the interface and
// code fonts, each a typed family with the app's suggestion list (FontField), and their
// weights as four radios; all applied at once (useTheme, useZoom, useFonts).

import { computed } from "vue";
import { useI18n } from "vue-i18n";

import RadioGroup from "@/components/RadioGroup.vue";
import Select from "@/components/Select.vue";
import type { RadioOption, SelectOption } from "@/components/types";
import { useShortcutHint } from "@/shortcuts/useShortcut";
import {
  fontWeights,
  themeNames,
  useSettingsStore,
  zoomLevels,
  type CodeTheme,
  type FontWeight,
  type Theme,
} from "@/stores/settings";
import { PALETTE_THEMES } from "@/styles/themes";

import FontField from "./FontField.vue";
import { fontSuggestions } from "./fontSuggestions";
import SettingsField from "./SettingsField.vue";
import SettingsSection from "./SettingsSection.vue";

const { t } = useI18n();
const settings = useSettingsStore();

/** Every theme by its label: Begitra's own in the language of the app, the palettes by name. */
const themeOptions = computed<SelectOption[]>(() =>
  themeNames.map((name) => ({
    value: name,
    label:
      name === "dark" || name === "light"
        ? t(`settings.appearance.themes.${name}`)
        : (PALETTE_THEMES.find((palette) => palette.id === name)?.name ?? name),
  })),
);
const themes = computed<SelectOption[]>(() => [
  { value: "system", label: t("settings.appearance.themes.system") },
  ...themeOptions.value,
]);
const codeThemes = computed<SelectOption[]>(() => [
  { value: "app", label: t("settings.appearance.sameAsApp") },
  ...themeOptions.value,
]);
const theme = computed({
  get: () => settings.values.theme,
  set: (value: string) => {
    if (value === "system" || (themeNames as readonly string[]).includes(value)) {
      void settings.update("theme", value as Theme);
    }
  },
});
const codeTheme = computed({
  get: () => settings.values.codeTheme,
  set: (value: string) => {
    if (value === "app" || (themeNames as readonly string[]).includes(value)) {
      void settings.update("codeTheme", value as CodeTheme);
    }
  },
});

const zoomOptions: SelectOption[] = zoomLevels.map((level) => ({
  value: String(level),
  label: `${level}%`,
}));
const zoom = computed({
  get: () => String(settings.values.zoom),
  set: (value: string) => {
    const level = zoomLevels.find((candidate) => String(candidate) === value);
    if (level !== undefined) void settings.update("zoom", level);
  },
});
const zoomIn = useShortcutHint("zoom-in");
const zoomOut = useShortcutHint("zoom-out");

const suggestions = computed(() => fontSuggestions(settings.platform));

const weights = computed<RadioOption[]>(() =>
  fontWeights.map((weight) => ({
    value: weight,
    label: t(`settings.appearance.weights.${weight}`),
  })),
);

function isWeight(value: string): value is FontWeight {
  return (fontWeights as readonly string[]).includes(value);
}

const uiWeight = computed({
  get: () => settings.values.uiWeight,
  set: (value: string) => {
    if (isWeight(value)) void settings.update("uiWeight", value);
  },
});
const codeWeight = computed({
  get: () => settings.values.codeWeight,
  set: (value: string) => {
    if (isWeight(value)) void settings.update("codeWeight", value);
  },
});
</script>

<template>
  <SettingsSection :title="t('settings.appearance.title')">
    <SettingsField
      :label="t('settings.appearance.theme')"
      for="settings-theme"
      :hint="t('settings.appearance.hint')"
    >
      <Select
        id="settings-theme"
        v-model="theme"
        class="settings-theme"
        :options="themes"
        data-testid="theme"
      />
    </SettingsField>
    <SettingsField
      :label="t('settings.appearance.codeTheme')"
      for="settings-code-theme"
      :hint="t('settings.appearance.codeThemeHint')"
    >
      <Select
        id="settings-code-theme"
        v-model="codeTheme"
        class="settings-theme"
        :options="codeThemes"
        data-testid="code-theme"
      />
    </SettingsField>
    <SettingsField
      :label="t('settings.appearance.zoom')"
      for="settings-zoom"
      :hint="t('settings.appearance.zoomHint', { in: zoomIn, out: zoomOut })"
    >
      <Select
        id="settings-zoom"
        v-model="zoom"
        class="settings-zoom"
        :options="zoomOptions"
        data-testid="zoom"
      />
    </SettingsField>
    <SettingsField
      :label="t('settings.appearance.uiFont')"
      for="settings-ui-font"
      :hint="t('settings.appearance.uiFontHint')"
    >
      <FontField
        id="settings-ui-font"
        :stored="settings.values.uiFont"
        :suggestions="suggestions.ui"
        placeholder="Geist"
        testid="ui-font"
        :label="t('settings.appearance.uiFont')"
        @apply="(value) => void settings.update('uiFont', value)"
      />
    </SettingsField>
    <SettingsField :label="t('settings.appearance.uiWeight')">
      <RadioGroup
        v-model="uiWeight"
        :options="weights"
        :label="t('settings.appearance.uiWeight')"
        inline
        data-testid="ui-weight"
      />
    </SettingsField>
    <SettingsField
      :label="t('settings.appearance.codeFont')"
      for="settings-code-font"
      :hint="t('settings.appearance.codeFontHint')"
    >
      <FontField
        id="settings-code-font"
        :stored="settings.values.codeFont"
        :suggestions="suggestions.code"
        placeholder="Geist Mono"
        testid="code-font"
        :label="t('settings.appearance.codeFont')"
        @apply="(value) => void settings.update('codeFont', value)"
      />
    </SettingsField>
    <SettingsField :label="t('settings.appearance.codeWeight')">
      <RadioGroup
        v-model="codeWeight"
        :options="weights"
        :label="t('settings.appearance.codeWeight')"
        inline
        data-testid="code-weight"
      />
    </SettingsField>
  </SettingsSection>
</template>

<style scoped>
/* As wide as the diff's tab width select: a short value. */
.settings-zoom {
  width: 96px;
}
</style>
