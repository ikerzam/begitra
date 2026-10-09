<script setup lang="ts">
// A commit box helper's failed read: one muted line, and git's output one click away when the
// failure carries it. Scrolls inside its list when the output is longer than the room.

import { ref, useId } from "vue";
import { useI18n } from "vue-i18n";

import type { AppError } from "@/ipc/errors";

const props = defineProps<{ error: AppError | null }>();

const { t } = useI18n();
const outputId = useId();
const shown = ref(false);
</script>

<template>
  <div class="flex min-h-0 flex-col gap-1 overflow-y-auto px-2 py-1">
    <p role="status" class="text-sm text-fg-muted">{{ t("commitHelpers.failed") }}</p>
    <button
      v-if="props.error?.detail"
      type="button"
      class="self-start text-sm text-link hover:underline"
      :aria-expanded="shown"
      :aria-controls="outputId"
      data-testid="helper-output-toggle"
      @click="shown = !shown"
    >
      {{ shown ? t("errorBanner.hideGitOutput") : t("errorBanner.showGitOutput") }}
    </button>
    <pre
      v-if="shown && props.error?.detail"
      :id="outputId"
      class="overflow-x-auto font-mono text-mono-sm whitespace-pre text-fg-secondary select-text"
      data-testid="helper-output"
      >{{ props.error.detail }}</pre>
  </div>
</template>
