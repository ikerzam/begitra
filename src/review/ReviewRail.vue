<script setup lang="ts">
// The review rail: change overview (totals, by type, by directory, largest changes,
// generated vs hand-written), review progress, the notes of the target and the keyboard
// hints pinned below.

import { PanelRightClose } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import DiffStat from "@/components/DiffStat.vue";
import IconButton from "@/components/IconButton.vue";
import Kbd from "@/components/Kbd.vue";
import PanelHeader from "@/components/PanelHeader.vue";
import Progress from "@/components/Progress.vue";
import { byDirectory, byType, largest, splitPath, totals } from "@/detail/groupFiles";
import type { FileChange } from "@/ipc/schemas";

import NotesBlock from "./NotesBlock.vue";

const props = defineProps<{ files: FileChange[]; reviewedCount: number }>();
const emit = defineEmits<{ hide: [] }>();

const { t, n } = useI18n();
const stats = computed(() => totals(props.files));
/** The five most frequent types with their labels; the rest fold into "Other" at the end. */
const types = computed(() => {
  const all = byType(props.files);
  const top = all.slice(0, 5).filter((entry) => entry.type !== "other");
  const rest = all
    .filter((entry) => !top.includes(entry))
    .reduce((sum, entry) => sum + entry.count, 0);
  const rows = top.map((entry) => ({
    key: entry.type,
    label: t(`review.types.${entry.type}`),
    count: entry.count,
  }));
  if (rest > 0) rows.push({ key: "other", label: t("review.types.other"), count: rest });
  return rows;
});
const biggest = computed(() => largest(props.files, 3));
const directories = computed(() => byDirectory(props.files, 5));

/** "+12,400", "+212 −190": the largest changes in `--text-secondary`, not the diff colours. */
function changeSize(file: FileChange): string {
  const parts: string[] = [];
  if (file.additions > 0) parts.push(`+${n(file.additions)}`);
  if (file.deletions > 0) parts.push(`−${n(file.deletions)}`);
  return parts.join(" ");
}
const handWritten = computed(() => stats.value.files - stats.value.generated);
const handShare = computed(() =>
  stats.value.files === 0 ? 0 : Math.round((handWritten.value / stats.value.files) * 100),
);
const reviewShare = computed(() =>
  stats.value.files === 0 ? 0 : Math.round((props.reviewedCount / stats.value.files) * 100),
);
</script>

<template>
  <aside class="flex min-w-0 flex-col border-l border-line" data-testid="review-rail">
    <PanelHeader :title="t('review.overview')">
      <template #actions>
        <IconButton
          :label="t('review.hideOverview')"
          :icon="PanelRightClose"
          @click="emit('hide')"
        />
      </template>
    </PanelHeader>
    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-3 text-md">
      <div class="flex flex-col gap-1 px-3">
        <div class="flex items-center gap-3">
          <span class="font-medium text-fg">{{ t("detail.files", { n: n(stats.files) }) }}</span>
          <DiffStat :added="stats.additions" :removed="stats.deletions" />
        </div>
        <p class="text-sm text-fg-muted">
          {{ t("review.added", { n: stats.added }) }}
          {{ t("review.modified", { n: stats.modified }) }}
          {{ t("review.deleted", { n: stats.deleted }) }}
        </p>
      </div>

      <div class="flex flex-col px-3">
        <h3 class="text-sm text-fg-secondary">{{ t("review.byType") }}</h3>
        <p
          v-for="entry in types"
          :key="entry.key"
          class="flex h-5 items-center justify-between text-fg"
          data-testid="review-type"
        >
          <span>{{ entry.label }}</span>
          <span class="text-sm text-fg-secondary">{{ n(entry.count) }}</span>
        </p>
      </div>

      <div v-if="directories.length > 1" class="flex flex-col px-3">
        <h3 class="text-sm text-fg-secondary">{{ t("review.byDirectory") }}</h3>
        <p
          v-for="entry in directories"
          :key="entry.folder"
          class="flex h-5 items-center justify-between gap-2"
          data-testid="review-directory"
        >
          <span class="truncate font-mono text-mono-sm text-fg">{{ entry.folder }}</span>
          <span class="text-sm text-fg-secondary">{{ n(entry.count) }}</span>
        </p>
      </div>

      <div v-if="biggest.length > 0" class="flex flex-col px-3">
        <h3 class="text-sm text-fg-secondary">{{ t("review.largest") }}</h3>
        <p
          v-for="file in biggest"
          :key="file.path"
          class="flex h-5 items-center justify-between gap-2"
        >
          <span class="truncate text-fg">{{ splitPath(file.path).name }}</span>
          <span class="text-sm text-fg-secondary">{{ changeSize(file) }}</span>
        </p>
      </div>

      <div class="flex flex-col gap-2 px-3">
        <h3 class="text-sm text-fg-secondary">{{ t("review.generatedVsHand") }}</h3>
        <Progress :value="handShare" :label="t('review.generatedVsHand')" />
        <p class="text-sm text-fg-muted">
          {{ t("review.handWritten", { n: handWritten }) }}
          {{ t("review.generated", { n: stats.generated }) }}
          {{ t("review.testsTouched", { n: stats.tests }) }}
        </p>
      </div>

      <div class="flex flex-col gap-2 border-t border-line px-3 pt-3">
        <h3 class="text-lg font-semibold text-fg">{{ t("review.progress") }}</h3>
        <p class="text-sm text-fg-secondary">
          {{ t("review.reviewed", { done: props.reviewedCount, total: stats.files }) }}
        </p>
        <Progress :value="reviewShare" variant="reviewed" :label="t('review.progress')" />
      </div>

      <NotesBlock />
    </div>
    <!-- Three 24px hint rows with 4px above and below (81px with the hairline). -->
    <div class="flex flex-col border-t border-line px-3 py-1 text-sm text-fg-muted">
      <span class="flex h-5 items-center gap-2"><Kbd keys="j/k" /> {{ t("review.nextFile") }}</span>
      <span class="flex h-5 items-center gap-2"><Kbd keys="n/p" /> {{ t("review.nextHunk") }}</span>
      <span class="flex h-5 items-center gap-2"
        ><Kbd keys="r" /> {{ t("review.markReviewed") }}</span
      >
    </div>
  </aside>
</template>
