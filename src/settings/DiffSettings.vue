<script setup lang="ts">
// The settings' Diff section: the viewer's three toggles, the tab width and the filters a review
// starts with ("Hide by default").

import { computed } from "vue";
import { useI18n } from "vue-i18n";

import Checkbox from "@/components/Checkbox.vue";
import Select from "@/components/Select.vue";
import Toggle from "@/components/Toggle.vue";
import type { SelectOption } from "@/components/types";
import { useSettingsStore, type HideByDefault, type TabWidth } from "@/stores/settings";

import SettingsField from "./SettingsField.vue";
import SettingsSection from "./SettingsSection.vue";

const { t } = useI18n();
const settings = useSettingsStore();

const tabWidthOptions: SelectOption[] = [2, 4, 8].map((width) => ({
  value: String(width),
  label: String(width),
}));
const tabWidth = computed({
  get: () => String(settings.values.tabWidth),
  set: (value: string) => {
    const width = Number(value) as TabWidth;
    if (width === 2 || width === 4 || width === 8) void settings.update("tabWidth", width);
  },
});

function setHide(key: keyof HideByDefault, value: boolean): void {
  void settings.update("hideByDefault", { ...settings.values.hideByDefault, [key]: value });
}
</script>

<template>
  <SettingsSection :title="t('settings.diff.title')">
    <SettingsField
      :label="t('settings.diff.ignoreWhitespace')"
      :hint="t('settings.diff.ignoreWhitespaceHint')"
    >
      <Toggle
        :model-value="settings.values.diffIgnoreWhitespace"
        :label="t('settings.diff.ignoreWhitespace')"
        data-testid="diff-ignore-whitespace"
        @update:model-value="(on) => void settings.update('diffIgnoreWhitespace', on)"
      />
    </SettingsField>
    <SettingsField :label="t('settings.diff.wordWrap')">
      <Toggle
        :model-value="settings.values.diffWrap"
        :label="t('settings.diff.wordWrap')"
        data-testid="diff-wrap"
        @update:model-value="(on) => void settings.update('diffWrap', on)"
      />
    </SettingsField>
    <SettingsField :label="t('settings.diff.sideBySide')">
      <Toggle
        :model-value="settings.values.diffLayout === 'side-by-side'"
        :label="t('settings.diff.sideBySide')"
        data-testid="diff-side-by-side"
        @update:model-value="
          (on) => void settings.update('diffLayout', on ? 'side-by-side' : 'unified')
        "
      />
    </SettingsField>
    <SettingsField :label="t('settings.diff.tabWidth')" for="settings-tab-width">
      <Select
        id="settings-tab-width"
        v-model="tabWidth"
        class="settings-tab-width"
        :options="tabWidthOptions"
        data-testid="tab-width"
      />
    </SettingsField>
    <SettingsField :label="t('settings.diff.hideByDefault')" :hint="t('settings.diff.hideHint')">
      <div class="flex items-center gap-6">
        <Checkbox
          :model-value="settings.values.hideByDefault.generated"
          :label="t('settings.diff.generated')"
          data-testid="hide-generated"
          @update:model-value="(on) => setHide('generated', on)"
        />
        <Checkbox
          :model-value="settings.values.hideByDefault.lockfiles"
          :label="t('settings.diff.lockfiles')"
          data-testid="hide-lockfiles"
          @update:model-value="(on) => setHide('lockfiles', on)"
        />
        <Checkbox
          :model-value="settings.values.hideByDefault.tests"
          :label="t('settings.diff.tests')"
          data-testid="hide-tests"
          @update:model-value="(on) => setHide('tests', on)"
        />
      </div>
    </SettingsField>
  </SettingsSection>
</template>

<style scoped>
/* The tab width select is 96px wide; off the spacing scale. */
.settings-tab-width {
  width: 96px;
}
</style>
