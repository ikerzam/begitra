<script setup lang="ts">
import { Check } from "@lucide/vue";
import { useI18n } from "vue-i18n";

const props = withDefaults(
  defineProps<{
    /** Hunk range as git prints it: "@@ -12,7 +12,9 @@". */
    range: string;
    /** Enclosing symbol, when git found one. */
    symbol?: string;
    reviewed?: boolean;
  }>(),
  { symbol: "", reviewed: false },
);

const emit = defineEmits<{ toggleReviewed: [] }>();

const { t } = useI18n();
</script>

<template>
  <div
    data-testid="hunk-row"
    class="flex h-row-hunk items-center gap-3 border-y border-line bg-hover pr-1 pl-3 text-md whitespace-nowrap"
  >
    <span class="shrink-0 font-mono text-mono-sm text-fg-muted" data-testid="hunk-row-range">
      {{ props.range }}
    </span>
    <span
      v-if="props.symbol"
      class="min-w-0 flex-1 truncate text-fg-secondary"
      data-testid="hunk-row-symbol"
    >
      {{ props.symbol }}
    </span>
    <!-- A ghost button whose label turns --reviewed once the hunk is marked; Button cannot recolour. -->
    <button
      type="button"
      :aria-pressed="props.reviewed"
      data-testid="hunk-row-reviewed"
      class="ml-auto inline-flex h-control shrink-0 items-center gap-2 rounded-md px-3 text-md font-medium hover:bg-hover active:bg-active"
      :class="props.reviewed ? 'text-reviewed' : 'text-fg-secondary hover:text-fg'"
      @click="emit('toggleReviewed')"
    >
      <Check :size="16" :stroke-width="1.5" aria-hidden="true" />
      {{ props.reviewed ? t("hunkRow.reviewed") : t("hunkRow.markReviewed") }}
    </button>
  </div>
</template>
