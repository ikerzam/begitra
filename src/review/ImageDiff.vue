<script setup lang="ts">
// The diff of an image file: the Before and After boxes (360px tall), each showing the
// picture read whole from its side, "Not in the parent commit" or "Deleted" for a missing
// side, and the size, dimensions and format under After.

import { Image as ImageIcon } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import * as ipc from "@/ipc/commands";
import { newOpId } from "@/ipc/invoke";
import type { BlobAt, FileChange } from "@/ipc/schemas";
import type { ReviewTarget } from "@/stores/review";

import { fileSides, imageType } from "./sides";

const props = defineProps<{ root: string; target: ReviewTarget; file: FileChange }>();

const { t, n } = useI18n();

interface Side {
  url: string | null;
  size: number;
  loading: boolean;
  failed: boolean;
}

const before = ref<Side>({ url: null, size: 0, loading: false, failed: false });
const after = ref<Side>({ url: null, size: 0, loading: false, failed: false });
const dimensions = ref<{ width: number; height: number } | null>(null);
let serial = 0;

const type = computed(() => imageType(props.file.path) ?? "application/octet-stream");
const format = computed(() => {
  const dot = props.file.path.lastIndexOf(".");
  return dot < 0 ? "" : props.file.path.slice(dot + 1).toUpperCase();
});

async function read(side: { at: BlobAt; path: string } | null): Promise<Side> {
  if (!side) return { url: null, size: 0, loading: false, failed: false };
  try {
    const blob = await ipc.readBlob(props.root, side.at, side.path, newOpId("image"));
    const data = blob.bytes ?? (blob.text !== undefined ? btoa(blob.text) : null);
    return {
      url: data ? `data:${type.value};base64,${data}` : null,
      size: blob.size,
      loading: false,
      failed: data === null,
    };
  } catch {
    return { url: null, size: 0, loading: false, failed: true };
  }
}

async function load(): Promise<void> {
  serial += 1;
  const mine = serial;
  dimensions.value = null;
  const sides = fileSides(props.target, props.file);
  before.value = { url: null, size: 0, loading: sides.old !== null, failed: false };
  after.value = { url: null, size: 0, loading: sides.new !== null, failed: false };
  const [older, newer] = await Promise.all([read(sides.old), read(sides.new)]);
  if (mine !== serial) return;
  before.value = older;
  after.value = newer;
}

watch(
  () => [props.root, props.target, props.file.path],
  () => void load(),
  { immediate: true },
);

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
  <div class="grid grid-cols-2 gap-4 p-4" data-testid="image-diff">
    <div class="flex flex-col gap-2">
      <span class="text-md text-fg-secondary">{{ t("review.image.before") }}</span>
      <div
        class="image-box flex items-center justify-center overflow-hidden rounded-md border border-line bg-raised"
        data-testid="image-before"
      >
        <img
          v-if="before.url"
          :src="before.url"
          :alt="props.file.oldPath ?? props.file.path"
          class="max-h-full max-w-full"
        />
        <span v-else-if="before.loading" class="text-md text-fg-muted">{{
          t("review.image.loading")
        }}</span>
        <span v-else class="text-md text-fg-muted">{{
          before.failed ? t("review.image.unreadable") : missingBefore
        }}</span>
      </div>
    </div>
    <div class="flex flex-col gap-2">
      <span class="text-md text-fg-secondary">{{ t("review.image.after") }}</span>
      <div
        class="image-box flex items-center justify-center overflow-hidden rounded-md border border-line bg-raised"
        data-testid="image-after"
      >
        <img
          v-if="after.url"
          :src="after.url"
          :alt="props.file.path"
          class="max-h-full max-w-full"
          @load="onLoaded"
        />
        <span v-else-if="after.loading" class="text-md text-fg-muted">{{
          t("review.image.loading")
        }}</span>
        <template v-else>
          <ImageIcon
            v-if="!after.failed && props.file.status !== 'deleted'"
            :size="40"
            :stroke-width="1"
            aria-hidden="true"
            class="text-fg-muted"
          />
          <span v-else class="text-md text-fg-muted">{{
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
