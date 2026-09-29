<script setup lang="ts">
// A run of unchanged lines folded before, between or after the hunks.
// The gutters hold the controls for the 20 lines after the change
// above and the 20 before the change below, where such a change exists and the run is longer
// than 20; then "N unchanged lines", which shows them all. While the new side is read the
// controls work (the lines show when it arrives); when it cannot be read, or no longer holds
// the hunks' lines, they are disabled and the tooltip says why. Every control passes its click
// on, so the rows can tell a keyboard's press (detail 0) and keep the focus with it.

import { ArrowDownFromLine, ArrowUpFromLine, UnfoldVertical } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import IconButton from "@/components/IconButton.vue";

import { EXPAND_STEP, type DiffLayout, type GapRowModel } from "./diffRows";
import type { NewSideState } from "./useNewSide";

const props = defineProps<{
  /** How many lines the row folds. */
  count: number;
  place: GapRowModel["place"];
  state: NewSideState;
  layout: DiffLayout;
}>();

const emit = defineEmits<{
  showAll: [event: MouseEvent];
  showNext: [event: MouseEvent];
  showPrevious: [event: MouseEvent];
}>();

const { t, n } = useI18n();

const stepped = computed(() => props.count > EXPAND_STEP);
const disabled = computed(() => props.state === "stale" || props.state === "failed");
const reason = computed(() => {
  if (props.state === "stale") return t("review.gap.stale");
  if (props.state === "failed") return t("review.gap.unreadable");
  return undefined;
});
</script>

<template>
  <div
    class="gap-row grid h-row-hunk items-center bg-hover font-ui text-sm text-fg-secondary"
    :class="{ 'gap-row-paired': props.layout === 'side-by-side' }"
    data-testid="gap-row"
  >
    <span class="flex items-center justify-end gap-1 pr-2">
      <IconButton
        v-if="stepped && props.place !== 'top'"
        :label="t('review.gap.next', { n: EXPAND_STEP })"
        :icon="ArrowDownFromLine"
        :disabled="disabled"
        data-testid="gap-next"
        @click="(event: MouseEvent) => emit('showNext', event)"
      />
      <IconButton
        v-if="stepped && props.place !== 'bottom'"
        :label="t('review.gap.previous', { n: EXPAND_STEP })"
        :icon="ArrowUpFromLine"
        :disabled="disabled"
        data-testid="gap-previous"
        @click="(event: MouseEvent) => emit('showPrevious', event)"
      />
    </span>
    <span class="min-w-0" :data-tooltip="reason">
      <button
        type="button"
        class="inline-flex h-control items-center gap-2 rounded-md px-2 whitespace-nowrap select-none enabled:hover:bg-hover enabled:hover:text-fg enabled:active:bg-active disabled:text-fg-disabled"
        :disabled="disabled"
        :aria-label="t('review.gap.showAll', { n: n(props.count) }, props.count)"
        data-testid="gap-all"
        @click="(event: MouseEvent) => emit('showAll', event)"
      >
        <UnfoldVertical :size="16" :stroke-width="1.5" aria-hidden="true" />
        {{ t("review.gap.lines", { n: n(props.count) }, props.count) }}
      </button>
    </span>
  </div>
</template>

<style scoped>
/* The step controls sit in the two numbers' gutters and the marker's (110px); the count
   starts at the code's column. Side by side the code starts after one side's number and
   marker (66px), which still holds the two controls. */
.gap-row {
  grid-template-columns:
    calc(var(--diff-gutter-w, 44px) * 2 + var(--diff-marker-w, 22px))
    minmax(0, 1fr);
}
.gap-row-paired {
  grid-template-columns:
    calc(var(--diff-gutter-w, 44px) + var(--diff-marker-w, 22px))
    minmax(0, 1fr);
}
</style>
