<script setup lang="ts">
// The settings' Appearance section: the theme as three radios, the zoom as a select, then the
// interface and code fonts, each a typed family with suggestions committed on Enter or blur,
// and their weights as four radios; all applied at once (useTheme, useZoom, useFonts).

import { computed, useId } from "vue";
import { useI18n } from "vue-i18n";

import Input from "@/components/Input.vue";
import RadioGroup from "@/components/RadioGroup.vue";
import Select from "@/components/Select.vue";
import type { RadioOption, SelectOption } from "@/components/types";
import { useShortcutHint } from "@/shortcuts/useShortcut";
import { fontWeights, useSettingsStore, zoomLevels, type FontWeight } from "@/stores/settings";

import { fontSuggestions } from "./fontSuggestions";
import SettingsField from "./SettingsField.vue";
import SettingsSection from "./SettingsSection.vue";
import { useCommittedText } from "./useCommittedText";

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
const uiFontsId = useId();
const codeFontsId = useId();

const uiFont = useCommittedText(
  () => settings.values.uiFont,
  (value) => settings.update("uiFont", value.trim().slice(0, 64)),
);
const codeFont = useCommittedText(
  () => settings.values.codeFont,
  (value) => settings.update("codeFont", value.trim().slice(0, 64)),
);

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
    <SettingsField :label="t('settings.appearance.theme')" :hint="t('settings.appearance.hint')">
      <RadioGroup
        v-model="theme"
        :options="themes"
        :label="t('settings.appearance.theme')"
        inline
        data-testid="theme"
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
      <Input
        id="settings-ui-font"
        v-model="uiFont.draft.value"
        placeholder="Geist"
        :list="uiFontsId"
        spellcheck="false"
        data-testid="ui-font"
        @blur="uiFont.commit"
        @keydown="uiFont.onKeydown"
      />
      <datalist :id="uiFontsId">
        <option v-for="font in suggestions.ui" :key="font" :value="font" />
      </datalist>
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
      <Input
        id="settings-code-font"
        v-model="codeFont.draft.value"
        placeholder="Geist Mono"
        :list="codeFontsId"
        spellcheck="false"
        data-testid="code-font"
        @blur="codeFont.commit"
        @keydown="codeFont.onKeydown"
      />
      <datalist :id="codeFontsId">
        <option v-for="font in suggestions.code" :key="font" :value="font" />
      </datalist>
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
