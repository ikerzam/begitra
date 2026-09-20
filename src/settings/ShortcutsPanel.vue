<script setup lang="ts">
// The settings' Shortcuts section: every listed binding as a row with its action, its `kbd`s
// (a next/previous row carries two) and "Change"; while a row captures, it reads "Press
// the keys…" and any refusal; an overridden row offers "Reset". The platform note closes
// the list.

import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Kbd from "@/components/Kbd.vue";
import { formatShortcut } from "@/shortcuts/platform";
import { shortcutRegistry } from "@/shortcuts/registry";
import { shortcutRows, useSettingsScreenStore, type ShortcutRow } from "@/stores/settingsScreen";

import SettingsSection from "./SettingsSection.vue";
import { useShortcutCapture } from "./useShortcutCapture";

const { t } = useI18n();
const screen = useSettingsScreenStore();
useShortcutCapture();

const platform = computed(() => shortcutRegistry().platform);
const list = ref<HTMLElement | null>(null);

function focusIn(rowKey: string, control: string): void {
  list.value
    ?.querySelector<HTMLElement>(
      `[data-testid="shortcut-${rowKey}"] [data-testid="shortcut-${control}"]`,
    )
    ?.focus();
}

// The row's "Change" leaves the DOM while it captures: the focus moves to "Cancel" and
// comes back to "Change" when the capture ends, instead of falling to the document.
watch(
  () => screen.capturing?.row.key ?? null,
  (current, previous) => {
    void nextTick(() => {
      if (current) focusIn(current, "cancel");
      else if (previous) focusIn(previous, "change");
    });
  },
);

function captureText(row: ShortcutRow): string {
  return row.groups.length > 1
    ? t("settings.shortcuts.pressKeysFor", {
        which:
          capturingGroup(row) === 0
            ? t("settings.shortcuts.next")
            : t("settings.shortcuts.previous"),
      })
    : t("settings.shortcuts.pressKeys");
}

/** What the screen reader hears: the capture prompt and the refusal, on one live element. */
const liveText = computed(() => {
  const current = screen.capturing;
  if (!current) return "";
  return [captureText(current.row), refusalText.value].filter(Boolean).join(" ");
});

function hints(row: ShortcutRow): string[] {
  return row.groups.map((group) => formatShortcut(screen.keysOfGroup(group), platform.value));
}

function capturingGroup(row: ShortcutRow): number | null {
  const current = screen.capturing;
  return current && current.row.key === row.key ? current.group : null;
}

const refusalText = computed(() => {
  const refusal = screen.refusal;
  if (!refusal) return "";
  switch (refusal.kind) {
    case "plain":
      return t("settings.shortcuts.refusedPlain");
    case "modifier-only":
      return t("settings.shortcuts.refusedModifier");
    case "taken": {
      const row = screen.rowOf(refusal.by);
      return t("settings.shortcuts.refusedTaken", {
        name: row ? t(`settings.shortcuts.rows.${row.key}`) : refusal.by,
      });
    }
  }
});
</script>

<template>
  <SettingsSection :title="t('settings.shortcuts.title')">
    <p class="sr-only" aria-live="polite">{{ liveText }}</p>
    <ul
      ref="list"
      class="flex flex-col"
      :aria-label="t('settings.shortcuts.title')"
      data-testid="shortcut-rows"
    >
      <li
        v-for="row in shortcutRows"
        :key="row.key"
        class="shortcut-row flex items-center gap-4"
        :data-testid="`shortcut-${row.key}`"
      >
        <span class="min-w-0 flex-1 truncate text-md text-fg">
          {{ t(`settings.shortcuts.rows.${row.key}`) }}
        </span>
        <template v-if="capturingGroup(row) !== null">
          <span class="text-sm text-fg-secondary" data-testid="shortcut-capturing">
            {{ captureText(row) }}
            <span v-if="refusalText" class="text-danger" data-testid="shortcut-refusal">
              {{ refusalText }}
            </span>
          </span>
          <Button variant="ghost" data-testid="shortcut-cancel" @click="screen.cancelCapture()">
            {{ t("dialog.cancel") }}
          </Button>
        </template>
        <template v-else>
          <span class="flex items-center gap-2">
            <Kbd v-for="(hint, i) in hints(row)" :key="i" :keys="hint" />
          </span>
          <Button
            v-if="screen.isOverridden(row)"
            variant="ghost"
            data-testid="shortcut-reset"
            @click="screen.reset(row)"
          >
            {{ t("settings.shortcuts.reset") }}
          </Button>
          <Button variant="ghost" data-testid="shortcut-change" @click="screen.startCapture(row)">
            {{ t("settings.shortcuts.change") }}
          </Button>
        </template>
      </li>
    </ul>
    <p class="border-b border-line pb-4 text-sm text-fg-muted">
      {{ t("settings.shortcuts.note") }}
    </p>
  </SettingsSection>
</template>

<style scoped>
/* Rows are 38px apart (28px controls with 10px between); off the
   spacing scale. */
.shortcut-row {
  height: 38px;
}
</style>
