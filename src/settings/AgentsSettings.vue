<script setup lang="ts">
// The settings' Agents section (`Settings / Agents`): what an agent connected to Begitra does,
// the command that registers the agent server with Claude Code in a read-only field with Copy,
// and the server's path; without a server beside the app, a sentence saying so.

import { Copy } from "@lucide/vue";
import { computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import { copyText } from "@/shell/clipboard";
import { shortcutRegistry } from "@/shortcuts/registry";
import { useSettingsScreenStore } from "@/stores/settingsScreen";
import { useToastsStore } from "@/stores/toasts";

import { agentCommand } from "./agentCommand";
import SettingsSection from "./SettingsSection.vue";

const { t } = useI18n();
const screen = useSettingsScreenStore();
const toasts = useToastsStore();

const server = computed(() => screen.appInfo?.agentServer ?? null);
const command = computed(() =>
  server.value === null ? null : agentCommand(server.value, shortcutRegistry().platform),
);

async function copy(): Promise<void> {
  if (command.value === null) return;
  if (await copyText(command.value)) {
    toasts.push({ kind: "success", message: t("settings.agents.copied") });
  } else {
    toasts.push({ kind: "error", message: t("graph.clipboardUnavailable") });
  }
}

/** The whole command selected on focus, for a copy by hand. */
function selectAll(event: FocusEvent): void {
  if (event.target instanceof HTMLInputElement) event.target.select();
}

onMounted(() => {
  if (screen.appInfoState === "pending") void screen.loadAppInfo();
});
</script>

<template>
  <SettingsSection :title="t('settings.agents.title')" data-testid="agents-settings">
    <p class="text-sm text-fg-secondary">{{ t("settings.agents.sentence") }}</p>
    <template v-if="command !== null">
      <div class="flex items-center gap-2">
        <input
          :value="command"
          readonly
          :aria-label="t('settings.agents.command')"
          class="h-control min-w-0 flex-1 rounded-sm border border-line-strong bg-app px-3 font-mono text-mono-sm text-fg"
          data-testid="agents-command"
          @focus="selectAll"
        />
        <Button variant="secondary" :icon="Copy" data-testid="agents-copy" @click="copy">
          {{ t("settings.agents.copy") }}
        </Button>
      </div>
      <p
        class="truncate font-mono text-mono-sm text-fg-muted select-text"
        data-testid="agents-path"
      >
        {{ server }}
      </p>
    </template>
    <p
      v-else-if="screen.appInfoState === 'loaded'"
      class="text-sm text-fg-muted"
      data-testid="agents-missing"
    >
      {{ t("settings.agents.missing") }}
    </p>
  </SettingsSection>
</template>
