<script setup lang="ts">
// A run of unchanged lines folded before, between or after the hunks.
// The gutters hold the controls for the 20 lines after the change
// above and the 20 before the change below, where such a change exists and the run is longer
// than 20; then "N unchanged lines", which shows them all. Disabled while the lines cannot be
// shown (the new side unread, or no longer the one the hunks came from).

import { ArrowDownFromLine, ArrowUpFromLine, UnfoldVertical } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";

import { EXPAND_STEP, type GapRowModel } from "./diffRows";

const props = defineProps<{
  /** How many lines the row folds. */
  count: number;
  place: GapRowModel["place"];
  disabled: boolean;
}>();

const emit = defineEmits<{ showAll: []; showNext: []; showPrevious: [] }>();

const { t, n } = useI18n();

const stepped = computed(() => props.count > EXPAND_STEP);
</script>

<template>
  <div
    class="gap-row grid h-row-hunk items-center bg-hover font-ui text-sm text-fg-muted"
    data-testid="gap-row"
  >
    <span class="flex items-center justify-end gap-1 pr-2">
      <IconButton
        v-if="stepped && props.place !== 'top'"
        :label="t('review.gap.next', { n: EXPAND_STEP })"
        :icon="ArrowDownFromLine"
        :disabled="props.disabled"
        data-testid="gap-next"
        @click="emit('showNext')"
      />
      <IconButton
        v-if="stepped && props.place !== 'bottom'"
        :label="t('review.gap.previous', { n: EXPAND_STEP })"
        :icon="ArrowUpFromLine"
        :disabled="props.disabled"
        data-testid="gap-previous"
        @click="emit('showPrevious')"
      />
    </span>
    <span class="min-w-0">
      <button
        type="button"
        class="inline-flex h-control items-center gap-2 rounded-md px-2 enabled:hover:bg-hover enabled:hover:text-fg disabled:text-fg-disabled"
        :disabled="props.disabled"
        :aria-label="t('review.gap.showAll', { n: n(props.count) }, props.count)"
        data-testid="gap-all"
        @click="emit('showAll')"
      >
        <UnfoldVertical :size="16" :stroke-width="1.5" aria-hidden="true" />
        {{ t("review.gap.lines", { n: n(props.count) }, props.count) }}
      </button>
    </span>
  </div>
</template>

<style scoped>
/* The step controls sit in the two numbers' gutters and the marker's (110px); the count
   starts at the code's column. */
.gap-row {
  grid-template-columns:
    calc(var(--diff-gutter-w, 44px) * 2 + var(--diff-marker-w, 22px))
    minmax(0, 1fr);
}
</style>
