<script setup lang="ts">
// The Terminal and editor settings: the terminal's and the editor's templates and "Editor at a
// line", committed on blur and Enter; an empty "Editor at a line" is derived from the editor.

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
const editorLine = useCommittedText(
  () => settings.values.editorLineCommand,
  (value) => settings.update("editorLineCommand", value.trim()),
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
    <SettingsField
      :label="t('settings.commands.editorLine')"
      for="settings-editor-line"
      :hint="t('settings.commands.editorLineHint')"
    >
      <Input
        id="settings-editor-line"
        v-model="editorLine.draft.value"
        placeholder="code -g {path}:{line}"
        data-testid="editor-line-command"
        @blur="editorLine.commit"
        @keydown="editorLine.onKeydown"
      />
    </SettingsField>
  </SettingsSection>
</template>
