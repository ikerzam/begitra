<script setup lang="ts">
// The comparison: the
// sidebar of graph focus, then the header, the merge-base line, the preview banner, the two
// side lists and "Files changed" on the review's files panel and viewer, whose target is the
// three-dot range of the endpoints. Both endpoints at the same commit show the empty state;
// a comparison that failed shows the banner in place of the merge-base line.

import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import EmptyState from "@/components/EmptyState.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import { applyFilters } from "@/detail/groupFiles";
import DiffView from "@/review/DiffView.vue";
import ReviewFilesPanel from "@/review/ReviewFilesPanel.vue";
import { branchLanes } from "@/shell/branchLanes";
import { errorText } from "@/shell/errorMessage";
import { relativeDate, shortHash } from "@/shell/format";
import PaneResizer from "@/shell/PaneResizer.vue";
import Sidebar from "@/shell/Sidebar.vue";
import SidebarRail from "@/shell/SidebarRail.vue";
import { useExternal } from "@/shell/useExternal";
import { useNow } from "@/shell/useNow";
import { useCompareStore, type CompareSide } from "@/stores/compare";
import { usePickerStore } from "@/stores/picker";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { paneLimits, useShellStore } from "@/stores/shell";

import CompareHeader from "./CompareHeader.vue";
import MergePreviewBanner from "./MergePreviewBanner.vue";
import SideCommits from "./SideCommits.vue";

const { t, n } = useI18n();
const shell = useShellStore();
const repo = useRepoStore();
const review = useReviewStore();
const compare = useCompareStore();
const picker = usePickerStore();
const external = useExternal();
const now = useNow();
const sideA = ref<{ focus(): void } | null>(null);

const showSidebar = computed(() => !shell.sidebarCollapsed);
const endpoints = computed(() => compare.endpoints);
const lanes = computed<Record<CompareSide, number>>(() => {
  const byRef = branchLanes(repo.refs);
  const laneOf = (rev: string) =>
    byRef.get(rev) ?? byRef.get(`refs/heads/${rev}`) ?? byRef.get(`refs/remotes/${rev}`) ?? 0;
  const pair = endpoints.value;
  return { a: pair ? laneOf(pair.a.rev) : 0, b: pair ? laneOf(pair.b.rev) : 0 };
});
const names = computed(() => ({
  a: endpoints.value?.a.label ?? "",
  b: endpoints.value?.b.label ?? "",
}));

const baseLine = computed(() => {
  const comparison = compare.comparison;
  if (!comparison) return null;
  const rel = relativeDate(comparison.base.time, now.value);
  return {
    hash: shortHash(comparison.base.hash),
    ago: rel.unit === "now" ? t("date.now") : t(`date.${rel.unit}`, { n: rel.n }),
    counts: compare.same
      ? t("compare.sameCounts")
      : t("compare.counts", {
          a: names.value.a,
          n: n(comparison.onlyInA),
          b: names.value.b,
          m: n(comparison.onlyInB),
        }),
  };
});
const comparisonError = computed(() => {
  const error = compare.comparisonError;
  if (!error) return "";
  const text = errorText(error);
  return t("compare.failed", {
    a: names.value.a,
    b: names.value.b,
    message: t(text.key, text.params),
  });
});
const emptySentence = computed(() =>
  t("compare.same", {
    a: names.value.a,
    b: names.value.b,
    hash: shortHash(compare.comparison?.a.hash ?? ""),
  }),
);

const files = computed(() => applyFilters(review.files, review.filters));
const openFile = computed(
  () => files.value.find((file) => file.path === review.selectedPath) ?? null,
);
const filesWidth = computed(() => `${shell.paneSizes.files}px`);

function pick(side: CompareSide): void {
  const pair = endpoints.value;
  if (!pair) return;
  picker.open({ kind: "compare", side, other: side === "a" ? pair.b : pair.a });
}

/** Selects the merge base in the graph when the history lists it. */
function selectBase(): void {
  const hash = compare.comparison?.base.hash;
  const index = hash ? repo.commits.findIndex((commit) => commit.hash === hash) : -1;
  if (index >= 0) repo.select(index);
}

defineExpose({ focusSides: () => sideA.value?.focus() });
</script>

<template>
  <div class="flex min-h-0 flex-1" data-testid="compare-layout">
    <Sidebar v-if="showSidebar" />
    <SidebarRail
      v-else
      :active="shell.sidebarTab"
      @select="(tab) => void shell.expandSidebar(tab)"
    />
    <div v-if="endpoints" class="flex min-h-0 min-w-0 flex-1 flex-col">
      <CompareHeader
        :a="endpoints.a"
        :b="endpoints.b"
        :lanes="lanes"
        @pick="pick"
        @swap="() => void compare.swap()"
        @open-terminal="() => void external.openTerminal()"
      />
      <div v-if="compare.comparisonError" class="p-4" data-testid="compare-error">
        <ErrorBanner
          :message="comparisonError"
          :output="compare.comparisonError.detail ?? compare.comparisonError.message"
          :action="t('palette.commandsById.open-terminal')"
          @action="() => void external.openTerminal()"
        />
      </div>
      <template v-else>
        <p
          class="flex h-panel-header shrink-0 items-center gap-4 px-4 text-md"
          data-testid="merge-base-line"
        >
          <span class="text-fg-secondary">{{ t("compare.mergeBase") }}</span>
          <template v-if="baseLine">
            <button
              type="button"
              class="font-mono text-mono-sm text-accent hover:underline"
              data-testid="merge-base-hash"
              @click="selectBase"
            >
              {{ baseLine.hash }}
            </button>
            <span class="text-fg-muted">{{ baseLine.ago }}</span>
            <span class="text-fg" data-testid="compare-counts">{{ baseLine.counts }}</span>
          </template>
          <span v-else class="text-fg-muted">{{ t("compare.counting") }}</span>
        </p>
        <EmptyState
          v-if="compare.same"
          class="flex-1"
          :message="emptySentence"
          data-testid="compare-same"
        >
          <Button variant="secondary" @click="pick('b')">{{ t("compare.pickAnother") }}</Button>
        </EmptyState>
        <template v-else-if="compare.comparison">
          <MergePreviewBanner
            :a="names.a"
            :b="names.b"
            :preview="compare.preview"
            :error="compare.previewError"
            :loading="compare.previewing"
            @open-terminal="() => void external.openTerminal()"
          />
          <div class="compare-sides flex shrink-0 border-y border-line" data-testid="compare-sides">
            <SideCommits
              ref="sideA"
              :name="names.a"
              :count="compare.comparison.onlyInA"
              :list="compare.sides.a"
              :lane="lanes.a"
              class="border-r border-line"
              @activate="(hash) => void compare.openCommit(hash)"
              @load-more="compare.loadMore('a')"
            />
            <SideCommits
              :name="names.b"
              :count="compare.comparison.onlyInB"
              :list="compare.sides.b"
              :lane="lanes.b"
              @activate="(hash) => void compare.openCommit(hash)"
              @load-more="compare.loadMore('b')"
            />
          </div>
          <div class="flex min-h-0 flex-1" data-testid="compare-files">
            <ReviewFilesPanel
              class="shrink-0"
              :style="{ width: filesWidth }"
              :title="t('compare.filesChanged')"
              :show-target="false"
              :conflicts="compare.conflicts"
            />
            <PaneResizer
              :size="shell.paneSizes.files"
              :min="paneLimits.files.min"
              :max="paneLimits.files.max"
              :label="t('review.files')"
              @resize="(px) => void shell.setPaneSize('files', px)"
            />
            <DiffView
              :file="openFile"
              :conflict="openFile !== null && compare.conflicts.has(openFile.path)"
              in-comparison
              @open-in-review="() => void compare.openInReview()"
            />
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* The side lists take 200px (four rows and the header); off the scale. */
.compare-sides {
  height: 200px;
}
</style>
