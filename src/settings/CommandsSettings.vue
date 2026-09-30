<script setup lang="ts">
// The settings' Terminal and editor section: the terminal's and the editor's templates and
// "Editor at a line", committed on blur and Enter; an empty "Editor at a line" is derived from
// the editor, and its placeholder shows what that gives. The hints name the placeholders as text:
// vue-i18n would read `{path}` in a message as a parameter.

import { computed } from "vue";
import { useI18n } from "vue-i18n";

import Input from "@/components/Input.vue";
import { lineTemplates } from "@/stores/externalTemplates";
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

/** What an empty "Editor at a line" runs: the editor's at-line form, else the editor itself. */
const derivedLine = computed(() => lineTemplates("", settings.editorTemplates)[0] ?? "");
const placeholders = { path: "{path}", line: "{line}" };
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
      :hint="t('settings.commands.hint', placeholders)"
      hint-id="settings-editor-hint"
    >
      <Input
        id="settings-editor"
        v-model="editor.draft.value"
        aria-describedby="settings-editor-hint"
        data-testid="editor-command"
        @blur="editor.commit"
        @keydown="editor.onKeydown"
      />
    </SettingsField>
    <SettingsField
      :label="t('settings.commands.editorLine')"
      for="settings-editor-line"
      :hint="t('settings.commands.editorLineHint', placeholders)"
      hint-id="settings-editor-line-hint"
    >
      <Input
        id="settings-editor-line"
        v-model="editorLine.draft.value"
        :placeholder="derivedLine"
        aria-describedby="settings-editor-line-hint"
        data-testid="editor-line-command"
        @blur="editorLine.commit"
        @keydown="editorLine.onKeydown"
      />
    </SettingsField>
  </SettingsSection>
</template>
