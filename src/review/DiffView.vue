<script setup lang="ts">
// The diff panel of review focus: file header and the unified hunks of the open file.

import { Check, Columns2, PanelRightOpen, Rows3 } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import DiffRow from "@/components/DiffRow.vue";
import DiffStat from "@/components/DiffStat.vue";
import EmptyState from "@/components/EmptyState.vue";
import HunkRow from "@/components/HunkRow.vue";
import IconButton from "@/components/IconButton.vue";
import { statusOf } from "@/detail/groupFiles";
import type { DiffLine, FileChange, Hunk } from "@/ipc/schemas";
import { useShortcut } from "@/shortcuts/useShortcut";
import { useReviewStore } from "@/stores/review";

const props = withDefaults(
  defineProps<{
    file: FileChange | null;
    /** The review rail is collapsed; offer the control that brings it back. */
    railCollapsed?: boolean;
  }>(),
  { railCollapsed: false },
);
const emit = defineEmits<{ showOverview: [] }>();

// Lines rendered before the diff is cut, so a huge file never stalls the panel.
const MAX_LINES = 1_500;

const { t } = useI18n();
const review = useReviewStore();
const body = ref<HTMLElement | null>(null);

const reviewed = computed(() => (props.file ? review.reviewed.has(props.file.path) : false));
const revealed = computed(() => (props.file ? review.revealed.has(props.file.path) : false));
const guarded = computed(
  () => props.file !== null && (props.file.isLarge || props.file.isGenerated) && !revealed.value,
);

interface Segment {
  text: string;
  emphasis: boolean;
}

/** Splits a line into plain and emphasised segments from its byte spans. */
function segments(line: DiffLine): Segment[] {
  if (line.spans.length === 0) return [{ text: line.text, emphasis: false }];
  const bytes = new TextEncoder().encode(line.text);
  const decoder = new TextDecoder();
  const result: Segment[] = [];
  let at = 0;
  for (const span of line.spans) {
    if (span.start > at)
      result.push({ text: decoder.decode(bytes.slice(at, span.start)), emphasis: false });
    result.push({ text: decoder.decode(bytes.slice(span.start, span.end)), emphasis: true });
    at = span.end;
  }
  if (at < bytes.length) result.push({ text: decoder.decode(bytes.slice(at)), emphasis: false });
  return result;
}

interface Row {
  key: string;
  hunk?: Hunk;
  line?: DiffLine;
}

const rows = computed<Row[]>(() => {
  if (!props.file) return [];
  const result: Row[] = [];
  let lines = 0;
  for (const [h, hunk] of props.file.hunks.entries()) {
    result.push({ key: `h${h}`, hunk });
    for (const [l, line] of hunk.lines.entries()) {
      if (lines >= MAX_LINES) return result;
      result.push({ key: `h${h}-l${l}`, line });
      lines += 1;
    }
  }
  return result;
});
const truncated = computed(
  () => (props.file?.hunks.reduce((n, hunk) => n + hunk.lines.length, 0) ?? 0) > MAX_LINES,
);

function lineKind(line: DiffLine): "context" | "add" | "del" {
  return line.kind === "added" ? "add" : line.kind === "removed" ? "del" : "context";
}

function hunkRange(hunk: Hunk): string {
  const match = /^@@[^@]*@@/.exec(hunk.header);
  return match ? match[0] : hunk.header;
}

function hunkSymbol(hunk: Hunk): string {
  return hunk.header.replace(/^@@[^@]*@@\s*/, "");
}

function moveHunk(step: number): void {
  const element = body.value;
  if (!element) return;
  const headers = [...element.querySelectorAll<HTMLElement>("[data-hunk]")];
  if (headers.length === 0) return;
  const top = element.scrollTop;
  let index = headers.findIndex((header) => header.offsetTop > top + 1);
  if (step < 0) {
    index = headers.findIndex((header) => header.offsetTop >= top) - 1;
    if (index < 0) index = headers.length - 1;
    while (index > 0 && headers[index] && headers[index]!.offsetTop >= top) index -= 1;
  } else if (index < 0) {
    index = 0;
  }
  headers[index]?.scrollIntoView({ block: "start" });
}

useShortcut("next-hunk", () => moveHunk(1));
useShortcut("previous-hunk", () => moveHunk(-1));
useShortcut("mark-reviewed", () => {
  if (props.file) review.toggleReviewed(props.file.path);
});
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
        <span v-if="props.file.isBinary" class="text-sm text-fg-muted">{{
          t("detail.binary")
        }}</span>
        <DiffStat
          v-if="!props.file.isBinary"
          :added="props.file.additions"
          :removed="props.file.deletions"
        />
        <IconButton :label="t('review.unified')" :icon="Rows3" pressed />
        <IconButton :label="t('review.sideBySide')" :icon="Columns2" disabled />
        <Button
          variant="ghost"
          :icon="Check"
          :class="reviewed ? 'text-ok' : ''"
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

    <div ref="body" class="min-h-0 flex-1 overflow-auto" data-testid="diff-body">
      <EmptyState v-if="!props.file" :message="t('review.noFile')" />
      <div v-else-if="props.file.isBinary" class="p-4">
        <div class="rounded-md border border-line p-4 text-md text-fg-secondary">
          {{ t("review.binaryFile", { status: statusOf(props.file.status) }) }}
        </div>
      </div>
      <div v-else-if="guarded" class="p-4" data-testid="diff-guard">
        <div
          class="flex flex-col items-start gap-3 rounded-md border border-line p-4 text-md text-fg-secondary"
        >
          <p>
            {{
              props.file.isLarge
                ? t("review.largeFile", { n: props.file.additions + props.file.deletions })
                : t("review.generatedFile")
            }}
          </p>
          <div class="flex items-center gap-2">
            <Button variant="secondary" @click="review.reveal(props.file.path)">
              {{ t("review.showAnyway") }}
            </Button>
            <Button variant="ghost" :icon="Check" @click="review.toggleReviewed(props.file.path)">
              {{ t("hunkRow.markReviewed") }}
            </Button>
          </div>
        </div>
      </div>
      <template v-else>
        <template v-for="row in rows" :key="row.key">
          <HunkRow
            v-if="row.hunk"
            data-hunk
            :range="hunkRange(row.hunk)"
            :symbol="hunkSymbol(row.hunk)"
            :reviewed="reviewed"
            @toggle-reviewed="review.toggleReviewed(props.file.path)"
          />
          <DiffRow
            v-else-if="row.line"
            :kind="lineKind(row.line)"
            :old-number="row.line.oldNumber ?? undefined"
            :new-number="row.line.newNumber ?? undefined"
          >
            <template v-for="(segment, i) in segments(row.line)" :key="i">
              <span
                v-if="segment.emphasis"
                :class="row.line.kind === 'added' ? 'bg-add-emphasis' : 'bg-del-emphasis'"
                >{{ segment.text }}</span
              >
              <template v-else>{{ segment.text }}</template>
            </template>
          </DiffRow>
        </template>
        <p v-if="truncated" class="px-3 py-2 text-sm text-fg-muted" data-testid="diff-truncated">
          {{ t("review.truncated", { n: MAX_LINES }) }}
        </p>
      </template>
    </div>
  </section>
</template>
