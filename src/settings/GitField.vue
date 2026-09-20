<script setup lang="ts">
// The settings' Git section, "Git executable": the path field, "Detect", and the line under them:
// the version once the path runs, the bar while detecting, the red
// sentence when the path does not run.

import { computed } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Input from "@/components/Input.vue";
import Progress from "@/components/Progress.vue";
import { useSettingsScreenStore } from "@/stores/settingsScreen";

import SettingsField from "./SettingsField.vue";
import { useCommittedText } from "./useCommittedText";

const { t } = useI18n();
const screen = useSettingsScreenStore();

const field = useCommittedText(
  () => screen.executable,
  (value) => screen.applyExecutable(value),
);
const busy = computed(() => screen.gitState === "detecting" || screen.gitState === "probing");
const failed = computed(() => screen.gitState === "error");
</script>

<template>
  <SettingsField
    :label="t('settings.git.executable')"
    for="settings-git-executable"
    :danger="failed"
    hint-id="settings-git-error"
    wide
  >
    <div class="flex items-center gap-3">
      <div class="settings-git-input">
        <Input
          id="settings-git-executable"
          v-model="field.draft.value"
          :placeholder="busy ? t('settings.git.detecting') : t('settings.git.placeholder')"
          :invalid="failed"
          :aria-describedby="failed ? 'settings-git-error' : undefined"
          data-testid="git-executable"
          @blur="field.commit"
          @keydown="field.onKeydown"
        />
      </div>
      <Button
        variant="secondary"
        class="shrink-0"
        :disabled="busy"
        data-testid="git-detect"
        @click="() => void screen.detect()"
      >
        {{ t("settings.git.detect") }}
      </Button>
    </div>
    <template #hint>
      <span v-if="busy" class="flex items-center gap-3" data-testid="git-detecting">
        <Progress class="git-progress" indeterminate :label="t('settings.git.looking')" />
        {{ t("settings.git.looking") }}
      </span>
      <span v-else-if="screen.gitState === 'ready'" data-testid="git-version">
        {{ screen.gitVersion }}
      </span>
      <span v-else-if="failed" data-testid="git-error">{{ t("settings.git.notGit") }}</span>
      <span v-else>{{ t("settings.git.hint") }}</span>
    </template>
  </SettingsField>
</template>

<style scoped>
/* The detection bar is 120px wide; the path field keeps the 420px of
   every other control with "Detect" beside it. Off the spacing scale. */
.git-progress {
  width: 120px;
}
.settings-git-input {
  width: 420px;
}
</style>
