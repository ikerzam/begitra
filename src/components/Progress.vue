<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import type { ProgressVariant } from "./types";

const props = withDefaults(
  defineProps<{
    /** Percentage from 0 to 100; values outside the range are clamped. */
    value?: number;
    /** Neutral while indexing or loading; `reviewed` for review progress. */
    variant?: ProgressVariant;
    label?: string;
    /** Sweeps when the total is unknown. */
    indeterminate?: boolean;
  }>(),
  { value: 0, variant: "neutral", label: "", indeterminate: false },
);

const { t } = useI18n();

const percent = computed(() => {
  const value = Number.isFinite(props.value) ? props.value : 0;
  return Math.min(100, Math.max(0, value));
});
</script>

<template>
  <div
    role="progressbar"
    :aria-valuenow="props.indeterminate ? undefined : percent"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-label="props.label || t('progress.label')"
    :aria-busy="props.indeterminate ? 'true' : undefined"
    :data-variant="props.variant"
    class="progress w-full overflow-hidden rounded-full bg-line-strong"
  >
    <div
      class="h-full rounded-full"
      :class="[
        props.variant === 'reviewed' ? 'bg-reviewed' : 'bg-fg-secondary',
        { 'progress-sweep': props.indeterminate },
      ]"
      :style="props.indeterminate ? undefined : { width: `${percent}%` }"
      data-testid="progress-fill"
    />
  </div>
</template>

<style scoped>
/* The track is 3px tall. */
.progress {
  height: 3px;
}

/* A 30% bar crossing the track: 100% of the track is 333% of the bar. */
.progress-sweep {
  width: 30%;
  animation: progress-sweep 1.2s linear infinite;
}

@keyframes progress-sweep {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(333%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .progress-sweep {
    width: 100%;
    animation: none;
  }
}
</style>
