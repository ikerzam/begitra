<script setup lang="ts">
// Fetch, Pull and Push in the top bar for the repository the graph shows, one click each: Pull
// with the commits to bring and Push with the commits to send as their counts, each unavailable
// with its reason as the tooltip (a detached HEAD, no remote, no upstream, nothing to push, a
// command running). Push shows no key: ⇧⌘P opens the push dialog. The tooltip's words reach
// assistive technology as each button's description. The plans and the words come from `useSync`
// and `useSyncTexts`.

import { Download, RefreshCw, Upload } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";
import { useShortcutHint } from "@/shortcuts/useShortcut";

import { useSync } from "./useSync";
import { useSyncTexts, type SyncButtonText } from "./useSyncTexts";

const { t } = useI18n();
const sync = useSync();
const texts = useSyncTexts(sync);
const fetchHint = useShortcutHint("fetch");
const pullHint = useShortcutHint("pull");

/** Why it cannot act, else where it goes with its key: the tooltip, said. */
function description(text: SyncButtonText, keys = ""): string {
  return text.unavailable || [text.tooltip, keys].filter((part) => part !== "").join(", ");
}
</script>

<template>
  <div
    class="flex shrink-0 items-center gap-1"
    role="group"
    :aria-label="t('sync.group')"
    data-testid="sync-buttons"
  >
    <IconButton
      :label="texts.fetch.value.label"
      :tooltip="texts.fetch.value.tooltip"
      :keys="fetchHint"
      :icon="RefreshCw"
      :unavailable="texts.fetch.value.unavailable"
      :aria-description="description(texts.fetch.value, fetchHint)"
      data-testid="sync-fetch"
      @click="() => void sync.runFetch()"
    />
    <IconButton
      :label="texts.pull.value.label"
      :tooltip="texts.pull.value.tooltip"
      :keys="pullHint"
      :icon="Download"
      :count="texts.pull.value.count"
      :unavailable="texts.pull.value.unavailable"
      :aria-description="description(texts.pull.value, pullHint)"
      data-testid="sync-pull"
      @click="() => void sync.runPull()"
    />
    <IconButton
      :label="texts.push.value.label"
      :tooltip="texts.push.value.tooltip"
      :icon="Upload"
      :count="texts.push.value.count"
      :unavailable="texts.push.value.unavailable"
      :aria-description="description(texts.push.value)"
      data-testid="sync-push"
      @click="() => void sync.runPush()"
    />
  </div>
</template>
