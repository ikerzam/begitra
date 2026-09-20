<script setup lang="ts">
// The diff panel of review focus: the file header (path, flags, stats, the layout, wrap and
// whitespace toggles, "Mark reviewed") and the body: the rows of the open file, or the
// card of a large, generated or binary file, the image view, the empty, loading and error states.

import { AlignLeft, Check, Columns2, PanelRightOpen, Rows3, WrapText } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import DiffStat from "@/components/DiffStat.vue";
import EmptyState from "@/components/EmptyState.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import IconButton from "@/components/IconButton.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import { statusOf } from "@/detail/groupFiles";
import * as ipc from "@/ipc/commands";
import { newOpId } from "@/ipc/invoke";
import type { DiffLine, FileChange, Hunk } from "@/ipc/schemas";
import { errorText } from "@/shell/errorMessage";
import { useShortcut } from "@/shortcuts/useShortcut";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";

import DiffRows from "./DiffRows.vue";
import ImageDiff from "./ImageDiff.vue";
import { fileSides, imageType } from "./sides";

const props = withDefaults(
  defineProps<{
    file: FileChange | null;
    /** The review rail is collapsed; offer the control that brings it back. */
    railCollapsed?: boolean;
  }>(),
  { railCollapsed: false },
);
const emit = defineEmits<{ showOverview: [] }>();

const { t, locale } = useI18n();
const repo = useRepoStore();
const review = useReviewStore();

const root = computed(() => repo.repo?.root ?? null);
const reviewed = computed(() => (props.file ? review.isReviewed(props.file.path) : false));
const revealed = computed(() => (props.file ? review.revealed.has(props.file.path) : false));
const guarded = computed(
  () => props.file !== null && (props.file.isLarge || props.file.isGenerated) && !revealed.value,
);
const isImage = computed(() => props.file !== null && imageType(props.file.path) !== null);
const loading = computed(() => review.changeSet?.loading ?? false);
const failed = computed(() => review.changeSet?.error ?? null);

/** A file read whole after a failed diff ("Show new file"), as one hunk of added lines. */
const shownFile = ref<{ path: string; hunk: Hunk } | null>(null);
const hunks = computed<Hunk[]>(() => {
  if (failed.value && shownFile.value && shownFile.value.path === props.file?.path) {
    return [shownFile.value.hunk];
  }
  return props.file?.hunks ?? [];
});

const failedMessage = computed(() => {
  if (!failed.value) return "";
  const text = errorText(failed.value);
  return t("review.diffFailed", {
    name: props.file?.path ?? t("review.theChangeSet"),
    message: t(text.key, text.params),
  });
});

async function showNewFile(): Promise<void> {
  const open = props.file;
  const target = review.target;
  const repoRoot = root.value;
  if (!open || !target || !repoRoot) return;
  const side = fileSides(target, open).new;
  if (!side) return;
  try {
    const blob = await ipc.readBlob(repoRoot, side.at, side.path, newOpId("blob"));
    const lines = (blob.text ?? "").replace(/\n$/, "").split("\n");
    const added: DiffLine[] = lines.map((text, i) => ({
      kind: "added",
      oldNumber: null,
      newNumber: i + 1,
      text,
      spans: [],
      noNewline: false,
    }));
    shownFile.value = {
      path: open.path,
      hunk: {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: added.length,
        header: `@@ -0,0 +1,${added.length} @@`,
        lines: added,
      },
    };
  } catch {
    shownFile.value = null;
  }
}

watch(
  () => props.file?.path,
  () => {
    shownFile.value = null;
  },
);

useShortcut("mark-reviewed", () => {
  if (props.file) review.toggleReviewed(props.file.path);
});

/* The status word of the binary card, in lower case ("binary, added"). */
const binaryStatus = computed(() =>
  props.file
    ? t(`statusLetter.title.${statusOf(props.file.status)}`).toLocaleLowerCase(locale.value)
    : "",
);
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col" data-testid="diff-view">
    <header
      class="flex h-panel-header shrink-0 items-center gap-3 border-b border-line px-3 whitespace-nowrap"
    >
      <template v-if="props.file">
        <span
          class="min-w-0 flex-1 truncate font-mono text-mono-sm text-fg"
          data-testid="diff-path"
        >
          {{ props.file.path }}
        </span>
        <span v-if="props.file.isGenerated" class="text-sm text-fg-muted">
          {{ t("detail.generatedLabel") }}
        </span>
        <span v-if="props.file.isBinary" class="text-sm text-fg-muted" data-testid="diff-binary">
          {{ t("review.binaryStatus", { status: binaryStatus }) }}
        </span>
        <DiffStat
          v-if="!props.file.isBinary"
          :added="props.file.additions"
          :removed="props.file.deletions"
        />
        <IconButton
          :label="t('review.unified')"
          :icon="Rows3"
          :pressed="review.layout === 'unified'"
          data-testid="layout-unified"
          @click="() => void review.setLayout('unified')"
        />
        <IconButton
          :label="t('review.sideBySide')"
          :icon="Columns2"
          :pressed="review.layout === 'side-by-side'"
          data-testid="layout-side-by-side"
          @click="() => void review.setLayout('side-by-side')"
        />
        <IconButton
          :label="t('review.wrap')"
          :icon="WrapText"
          :pressed="review.wrap"
          data-testid="toggle-wrap"
          @click="() => void review.setWrap(!review.wrap)"
        />
        <IconButton
          :label="t('review.ignoreWhitespace')"
          :icon="AlignLeft"
          :pressed="review.ignoreWhitespace"
          data-testid="toggle-whitespace"
          @click="() => void review.setIgnoreWhitespace(!review.ignoreWhitespace)"
        />
        <Button
          variant="ghost"
          :icon="Check"
          :class="reviewed ? 'text-reviewed' : ''"
          data-testid="mark-reviewed"
          @click="review.toggleReviewed(props.file.path)"
        >
          {{ reviewed ? t("hunkRow.reviewed") : t("hunkRow.markReviewed") }}
        </Button>
      </template>
      <span v-else class="flex-1"></span>
      <IconButton
        v-if="props.railCollapsed"
        :label="t('review.showOverview')"
        :icon="PanelRightOpen"
        data-testid="show-overview"
        @click="emit('showOverview')"
      />
    </header>

    <div v-if="failed" class="p-4" data-testid="diff-failed">
      <ErrorBanner
        :message="failedMessage"
        :output="failed.detail ?? failed.message"
        :action="props.file && !shownFile ? t('review.showNewFile') : ''"
        open
        @action="() => void showNewFile()"
      />
    </div>

    <div
      v-if="loading && !props.file"
      class="min-h-0 flex-1 overflow-hidden"
      data-testid="diff-loading"
    >
      <SkeletonRow v-for="n in 12" :key="`skeleton-${n}`" :index="n" height="tree" />
    </div>
    <EmptyState v-else-if="!props.file" :message="t('review.noFile')" />
    <ImageDiff
      v-else-if="isImage && root && review.target"
      :root="root"
      :target="review.target"
      :file="props.file"
    />
    <div v-else-if="props.file.isBinary" class="p-4">
      <div class="rounded-md border border-line p-4 text-md text-fg-secondary">
        {{ t("review.binaryFile", { status: binaryStatus }) }}
      </div>
    </div>
    <div v-else-if="guarded" class="p-4" data-testid="diff-guard">
      <div
        class="flex flex-col items-start gap-3 rounded-md border border-line p-4 text-md text-fg-secondary"
      >
        <p class="text-fg">
          {{
            props.file.isLarge
              ? t("review.largeTitle", { n: props.file.additions + props.file.deletions })
              : t("review.generatedTitle", { n: props.file.additions })
          }}
        </p>
        <p>{{ props.file.isLarge ? t("review.largeFile") : t("review.generatedFile") }}</p>
        <div class="flex items-center gap-2">
          <Button variant="secondary" @click="review.reveal(props.file.path)">
            {{ t("review.showAnyway") }}
          </Button>
          <Button
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
    <DiffRows
      v-else-if="hunks.length > 0 || !failed"
      :file="props.file"
      :hunks="hunks"
      :highlighted="!shownFile"
    />
  </section>
</template>
