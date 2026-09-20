<script setup lang="ts">
// The merge preview banner of the comparison, in its states: computing (with
// the bar), fast-forward, up to date, clean, conflicts with the
// paths and the reminder that nothing is written, and the failure with
// the raw git output while the lists stay.

import { CircleAlert, CircleCheck, FastForward, Loader, Terminal } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import Progress from "@/components/Progress.vue";
import type { AppError } from "@/ipc/errors";
import type { MergePreview } from "@/ipc/schemas";
import { errorText } from "@/shell/errorMessage";

const props = defineProps<{
  a: string;
  b: string;
  preview: MergePreview | null;
  error: AppError | null;
  loading: boolean;
}>();
const emit = defineEmits<{ openTerminal: [] }>();

const { t, n } = useI18n();

const kind = computed(() => props.preview?.kind ?? null);
const title = computed(() => {
  const names = { a: props.a, b: props.b };
  switch (kind.value) {
    case "fast-forward":
      return t("compare.preview.fastForward", names);
    case "up-to-date":
      return t("compare.preview.upToDate", names);
    case "clean":
      return t("compare.preview.clean", names);
    case "conflicts": {
      const count = props.preview?.conflicts.length ?? 0;
      return t("compare.preview.conflicts", { ...names, n: n(count) }, count);
    }
    default:
      return "";
  }
});
const body = computed(() =>
  kind.value === "fast-forward" ? t("compare.preview.fastForwardBody", { a: props.a }) : "",
);
const errorMessage = computed(() => {
  if (!props.error) return "";
  const text = errorText(props.error);
  return t("compare.preview.failed", { message: t(text.key, text.params) });
});
</script>

<template>
  <!-- Inset from the panel edges: 12px at the sides, 8px above and
       4px below, before the hairline of the side lists. -->
  <div class="px-3 pt-2 pb-1" data-testid="merge-preview">
    <ErrorBanner
      v-if="props.error"
      :message="errorMessage"
      :output="props.error.detail ?? props.error.message"
      :action="t('palette.commandsById.open-terminal')"
      :action-icon="Terminal"
      open
      @action="emit('openTerminal')"
    />
    <div
      v-else-if="props.loading"
      class="flex flex-col gap-2 rounded-md border border-line-strong p-3 text-md"
      data-testid="merge-preview-loading"
    >
      <div class="flex items-center gap-3">
        <Loader :size="16" :stroke-width="1.5" aria-hidden="true" class="text-fg-secondary" />
        <span class="text-fg">{{ t("compare.preview.computing") }}</span>
      </div>
      <div class="flex items-center gap-3">
        <span aria-hidden="true" class="w-icon shrink-0" />
        <Progress class="preview-progress" indeterminate :label="t('compare.preview.computing')" />
      </div>
    </div>
    <div
      v-else-if="kind"
      class="flex items-start gap-3 rounded-md border border-line-strong p-3 text-md"
      :data-testid="`merge-preview-${kind}`"
    >
      <component
        :is="
          kind === 'conflicts' ? CircleAlert : kind === 'fast-forward' ? FastForward : CircleCheck
        "
        :size="16"
        :stroke-width="1.5"
        aria-hidden="true"
        class="mt-px shrink-0"
        :class="kind === 'conflicts' ? 'text-danger' : 'text-ok'"
      />
      <div class="flex min-w-0 flex-1 flex-col gap-2">
        <p class="font-medium text-fg">{{ title }}</p>
        <p v-if="body" class="text-fg-muted">{{ body }}</p>
        <template v-if="kind === 'conflicts'">
          <ul class="flex flex-col gap-1 font-mono text-mono-sm text-fg-secondary">
            <li v-for="path in props.preview?.conflicts" :key="path" data-testid="conflict-path">
              {{ path }}
            </li>
          </ul>
          <p class="text-fg-muted">{{ t("compare.preview.previewOnly") }}</p>
        </template>
      </div>
      <Button
        v-if="kind === 'conflicts'"
        variant="ghost"
        class="shrink-0"
        :icon="Terminal"
        @click="emit('openTerminal')"
      >
        {{ t("palette.commandsById.open-terminal") }}
      </Button>
    </div>
  </div>
</template>

<style scoped>
/* The loading bar is 240px wide; off the spacing scale. */
.preview-progress {
  width: 240px;
}
</style>
