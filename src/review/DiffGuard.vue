<script setup lang="ts">
// The card that stands in for a file's rows, shared by generated, large, binary and
// unmerged files: a title, one sentence, and the actions ("Show anyway" where there are
// rows to show, "Mark reviewed" always).

import { Check } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import { statusOf } from "@/detail/groupFiles";
import type { FileChange } from "@/ipc/schemas";
import { useReviewStore } from "@/stores/review";

const props = withDefaults(
  defineProps<{
    file: FileChange;
    reason: "large" | "generated" | "binary" | "unmerged";
    /** Whether "Mark reviewed" is offered (not on the changes screen). */
    reviewable?: boolean;
  }>(),
  { reviewable: true },
);
/** "Show anyway": the owner reveals the file. */
const emit = defineEmits<{ reveal: [] }>();

const { t, n, locale } = useI18n();
const review = useReviewStore();

const reviewed = computed(() => review.isReviewed(props.file.path));
const binaryStatus = computed(() =>
  t(`statusLetter.title.${statusOf(props.file.status)}`).toLocaleLowerCase(locale.value),
);
const title = computed(() => {
  switch (props.reason) {
    case "large":
      return t("review.largeTitle", { n: n(props.file.additions + props.file.deletions) });
    case "generated":
      return t("review.generatedTitle", { n: n(props.file.additions) });
    case "binary":
      return t("review.binaryFile", { status: binaryStatus.value });
    case "unmerged":
      return t("review.unmergedTitle");
  }
});
const bodyKeys = {
  large: "review.largeFile",
  generated: "review.generatedFile",
  binary: "review.binaryFileBody",
  unmerged: "review.unmergedFile",
} as const;
const body = computed(() => t(bodyKeys[props.reason]));
const canShow = computed(() => props.reason === "large" || props.reason === "generated");
</script>

<template>
  <!-- The card sits 24px from the header and the panel edges. -->
  <div class="p-5" data-testid="diff-guard">
    <div
      class="flex flex-col items-start rounded-md border border-line-strong p-5 text-md text-fg-secondary"
    >
      <p class="font-medium text-fg" data-testid="diff-guard-title">{{ title }}</p>
      <p class="mt-2">{{ body }}</p>
      <div class="mt-4 flex items-center gap-2">
        <Button v-if="canShow" variant="secondary" @click="emit('reveal')">
          {{ t("review.showAnyway") }}
        </Button>
        <Button
          v-if="props.reviewable"
          variant="ghost"
          :icon="Check"
          :class="reviewed ? 'text-reviewed' : ''"
          @click="review.toggleReviewed(props.file.path)"
        >
          {{ reviewed ? t("hunkRow.reviewed") : t("hunkRow.markReviewed") }}
        </Button>
      </div>
    </div>
  </div>
</template>
