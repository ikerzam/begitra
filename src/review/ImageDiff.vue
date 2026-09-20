<script setup lang="ts">
// The diff of an image file: the Before and After boxes (360px tall), each showing the
// picture read whole from its side, "Not in the parent commit" or "Deleted" for a missing
// side, and the size, dimensions and format under After.

import { Image as ImageIcon } from "@lucide/vue";
import { computed, ref, toRef } from "vue";
import { useI18n } from "vue-i18n";

import type { FileChange } from "@/ipc/schemas";
import type { ReviewTarget } from "@/stores/review";

import { useImageSides } from "./useImageSides";

const props = defineProps<{ root: string; target: ReviewTarget; file: FileChange }>();

const { t, n } = useI18n();

const { before, after } = useImageSides(
  toRef(props, "root"),
  toRef(props, "target"),
  toRef(props, "file"),
);
const dimensions = ref<{ width: number; height: number } | null>(null);

const format = computed(() => {
  const dot = props.file.path.lastIndexOf(".");
  return dot < 0 ? "" : props.file.path.slice(dot + 1).toUpperCase();
});

function onLoaded(event: Event): void {
  const image = event.target;
  if (image instanceof HTMLImageElement) {
    dimensions.value = { width: image.naturalWidth, height: image.naturalHeight };
  }
}

const missingBefore = computed(() =>
  props.file.status === "added" ? t("review.image.notInParent") : t("review.image.missing"),
);
const missingAfter = computed(() =>
  props.file.status === "deleted" ? t("review.image.deleted") : t("review.image.missing"),
);

const afterLine = computed(() => {
  if (!after.value.url) return "";
  const parts: string[] = [];
  if (dimensions.value) {
    parts.push(`${n(dimensions.value.width)} × ${n(dimensions.value.height)}`);
  }
  parts.push(t("review.image.size", { n: n(Math.max(1, Math.round(after.value.size / 1024))) }));
  if (format.value) parts.push(format.value);
  return parts.join("  ");
});
</script>

<template>
  <!-- 24px margins and gap, boxes on the app background with the hairline. -->
  <div class="grid grid-cols-2 gap-5 p-5" data-testid="image-diff">
    <div class="flex flex-col gap-2">
      <span class="text-sm text-fg-secondary">{{ t("review.image.before") }}</span>
      <div
        class="image-box flex items-center justify-center overflow-hidden rounded-md border border-line bg-app"
        data-testid="image-before"
      >
        <img
          v-if="before.url"
          :src="before.url"
          :alt="props.file.oldPath ?? props.file.path"
          class="max-h-full max-w-full"
        />
        <span v-else-if="before.loading" class="text-sm text-fg-muted">{{
          t("review.image.loading")
        }}</span>
        <span v-else class="text-sm text-fg-muted">{{
          before.failed ? t("review.image.unreadable") : missingBefore
        }}</span>
      </div>
    </div>
    <div class="flex flex-col gap-2">
      <span class="text-sm text-fg-secondary">{{ t("review.image.after") }}</span>
      <div
        class="image-box flex items-center justify-center overflow-hidden rounded-md border border-line bg-app"
        data-testid="image-after"
      >
        <img
          v-if="after.url"
          :src="after.url"
          :alt="props.file.path"
          class="max-h-full max-w-full"
          @load="onLoaded"
        />
        <span v-else-if="after.loading" class="text-sm text-fg-muted">{{
          t("review.image.loading")
        }}</span>
        <template v-else>
          <ImageIcon
            v-if="!after.failed && props.file.status !== 'deleted'"
            :size="24"
            :stroke-width="1.5"
            aria-hidden="true"
            class="text-fg-muted"
          />
          <span v-else class="text-sm text-fg-muted">{{
            after.failed ? t("review.image.unreadable") : missingAfter
          }}</span>
        </template>
      </div>
      <span v-if="afterLine" class="text-sm text-fg-muted" data-testid="image-after-line">{{
        afterLine
      }}</span>
    </div>
  </div>
</template>

<style scoped>
/* The Before and After boxes are 360px tall. */
.image-box {
  height: 360px;
}
</style>
