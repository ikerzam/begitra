<script setup lang="ts">
// git's words for a sequencer action or a resolution that failed (a continue git refused, a
// "Mark resolved" it refused, a reload of the state that failed), under the banner that shows:
// the operation's, or the kept stash's while the conflicts that came back from it are resolved.

import { computed } from "vue";
import { useI18n } from "vue-i18n";

import ErrorBanner from "@/components/ErrorBanner.vue";
import { errorText } from "@/shell/errorMessage";
import { useSequencerStore } from "@/stores/sequencer";

const { t } = useI18n();
const sequencer = useSequencerStore();

const failure = computed(() => {
  const error = sequencer.error;
  if (!error) return null;
  const text = errorText(error);
  return {
    message: t("sequencer.banner.failed", { message: t(text.key, text.params) }),
    output: error.detail ?? error.message,
  };
});
</script>

<template>
  <div v-if="failure" class="px-3 pb-3" data-testid="operation-failed">
    <ErrorBanner :message="failure.message" :output="failure.output" open />
  </div>
</template>
