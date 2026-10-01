<script setup lang="ts">
import { Check, CircleCheck } from "@lucide/vue";
import { computed } from "vue";
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

/** The control's name and tooltip: the action before the mark, the state after. */
const reviewedLabel = computed(() =>
  props.reviewed ? t("hunkRow.reviewed") : t("hunkRow.markReviewed"),
);
</script>

<template>
  <div
    data-testid="hunk-row"
    class="flex h-row-hunk items-center gap-3 border-y border-line bg-hover pr-3 pl-3 font-ui text-md font-normal whitespace-nowrap"
  >
    <span class="shrink-0 font-mono text-mono-sm text-fg-muted" data-testid="hunk-row-range">
      {{ props.range }}
    </span>
    <span
      v-if="props.symbol"
      class="flex-1 truncate text-sm text-fg-secondary"
      data-testid="hunk-row-symbol"
    >
      {{ props.symbol }}
    </span>
    <!-- The actions: the reviewed control by default; the changes screen puts its own here. -->
    <div class="ml-auto flex shrink-0 items-center gap-2" data-testid="hunk-row-actions">
      <slot>
        <!-- An icon toggle: a check before the mark, a circled check in --reviewed after it. The
             shape says the state without the colour, and IconButton's pressed fill cannot
             recolour the icon. -->
        <button
          type="button"
          :aria-pressed="props.reviewed"
          :aria-label="reviewedLabel"
          :data-tooltip="reviewedLabel"
          data-testid="hunk-row-reviewed"
          class="inline-flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-hover active:bg-active"
          :class="props.reviewed ? 'text-reviewed' : 'text-fg-secondary hover:text-fg'"
          @click="emit('toggleReviewed')"
        >
          <component
            :is="props.reviewed ? CircleCheck : Check"
            :size="16"
            :stroke-width="1.5"
            aria-hidden="true"
          />
        </button>
      </slot>
    </div>
  </div>
</template>
