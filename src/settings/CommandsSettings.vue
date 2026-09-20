<script setup lang="ts">
// The Terminal and editor settings: the two command templates, committed on blur and Enter.

import { useI18n } from "vue-i18n";

import Input from "@/components/Input.vue";
import { useSettingsStore } from "@/stores/settings";

import SettingsField from "./SettingsField.vue";
import SettingsSection from "./SettingsSection.vue";
import { useCommittedText } from "./useCommittedText";

const { t } = useI18n();
const settings = useSettingsStore();

const terminal = useCommittedText(
  () => settings.values.terminalCommand,
  (value) => (value.trim() ? settings.update("terminalCommand", value.trim()) : undefined),
);
const editor = useCommittedText(
  () => settings.values.editorCommand,
  (value) => (value.trim() ? settings.update("editorCommand", value.trim()) : undefined),
);
</script>

<template>
  <SettingsSection :title="t('settings.commands.title')">
    <SettingsField :label="t('settings.commands.terminal')" for="settings-terminal">
      <Input
        id="settings-terminal"
        v-model="terminal.draft.value"
        data-testid="terminal-command"
        @blur="terminal.commit"
        @keydown="terminal.onKeydown"
      />
    </SettingsField>
    <SettingsField
      :label="t('settings.commands.editor')"
      for="settings-editor"
      :hint="t('settings.commands.hint')"
    >
      <Input
        id="settings-editor"
        v-model="editor.draft.value"
        data-testid="editor-command"
        @blur="editor.commit"
        @keydown="editor.onKeydown"
      />
    </SettingsField>
  </SettingsSection>
</template>
