<script setup lang="ts">
// The viewer of the changes screen: the file header with the
// stats, the layout and wrap toggles and the file action ("Discard file…" on an unstaged
// file, "Unstage file" on a staged one), the banner of a failed write with git's output, and
// the review rows with "Stage hunk" / "Unstage hunk" / "Discard hunk…" on every hunk header,
// which turn into "… lines" once lines are picked. The picked lines live here, keyed
// `hunk:line`, and clear when the file changes or a write starts.

import {
  Check,
  Code,
  Columns2,
  Minus,
  Plus,
  Rows3,
  Undo2,
  UnfoldVertical,
  WrapText,
} from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import DiffStat from "@/components/DiffStat.vue";
import EmptyState from "@/components/EmptyState.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import IconButton from "@/components/IconButton.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import type { FileChange } from "@/ipc/schemas";
import DiffGuard from "@/review/DiffGuard.vue";
import DiffPath from "@/review/DiffPath.vue";
import DiffRows from "@/review/DiffRows.vue";
import ImageDiff from "@/review/ImageDiff.vue";
import { imageType } from "@/review/sides";
import { headerLine, useFileOpener, useOpenFileShortcut } from "@/review/useFileOpener";
import { errorText } from "@/shell/errorMessage";
import { useShortcutHint } from "@/shortcuts/useShortcut";
import { useCodeTheme } from "@/shell/useTheme";
import { lineKey, type ChangeList } from "@/stores/changes";
import { useReviewStore, type ReviewTarget } from "@/stores/review";
import { useSequencerStore } from "@/stores/sequencer";

import type { DiscardRequest } from "./discard";
import { useChanges, useOpenRepositoryChanges } from "./useChanges";

const emit = defineEmits<{ discard: [request: DiscardRequest] }>();

const { t, n } = useI18n();
const changes = useChanges();
/** The operation's conflicts belong to the open repository alone. */
const openRepository = useOpenRepositoryChanges();
const review = useReviewStore();
const sequencer = useSequencerStore();

const root = computed(() => changes.root);
const opener = useFileOpener(root);
const codeTheme = useCodeTheme();
const wholeFileKeys = useShortcutHint("toggle-whole-file");
const list = computed<ChangeList | null>(() => changes.selected?.list ?? null);
const file = computed(() => changes.selectedFile);
const target = computed<ReviewTarget | null>(() =>
  list.value === null ? null : list.value === "unstaged" ? { kind: "worktree" } : { kind: "index" },
);
const isImage = computed(() => file.value !== null && imageType(file.value.path) !== null);
const revealed = ref(new Set<string>());
const selected = ref(new Set<string>());

/** Why the file sits behind the card, if it does. */
const guard = computed<"large" | "generated" | "binary" | "unmerged" | null>(() => {
  const open = file.value;
  if (!open) return null;
  if (open.isBinary && !isImage.value) return "binary";
  if (open.status === "unmerged" && open.hunks.length === 0) return "unmerged";
  if ((open.isLarge || open.isGenerated) && !revealed.value.has(open.path)) {
    return open.isLarge ? "large" : "generated";
  }
  return null;
});

/** Lines can be picked on a text file whose bytes the diff carries faithfully. */
const selectable = computed(
  () => file.value !== null && !file.value.isLossy && !file.value.isBinary,
);
/** Whether part of an unstaged file can be discarded: not an untracked file, nor a deletion. */
const partialDiscard = computed(
  () =>
    list.value === "unstaged" &&
    file.value !== null &&
    file.value.status !== "added" &&
    file.value.status !== "deleted",
);
const busy = computed(() => changes.busy !== null);
/** The open file is one of the operation's conflicts: "Mark resolved" in the header. */
const conflicted = computed(
  () =>
    openRepository &&
    file.value !== null &&
    sequencer.conflicts.some((entry) => entry.path === file.value?.path),
);
const selectedCount = computed(() => selected.value.size);

/** The editor button names the line it opens at when the diff tells it. */
const editorLabel = computed(() => {
  const line = file.value ? headerLine(file.value) : null;
  return line === null ? t("fileMenu.openInEditor") : t("lineMenu.openAtLine", { line });
});
/** The rows' own line at the top, read by ⇧⌘E. */
const rows = ref<{ lineAtTop: () => number | null } | null>(null);
useOpenFileShortcut(root, file, () => rows.value?.lineAtTop());

/** The keys of every changed line of a hunk. */
function hunkKeys(open: FileChange, hunkIndex: number): Set<string> {
  const keys = new Set<string>();
  open.hunks[hunkIndex]?.lines.forEach((line, l) => {
    if (line.kind !== "context") keys.add(lineKey(hunkIndex, l));
  });
  return keys;
}

/** The picked lines inside a hunk. */
function pickedIn(hunkIndex: number): Set<string> {
  const keys = new Set<string>();
  for (const key of selected.value) if (key.startsWith(`${hunkIndex}:`)) keys.add(key);
  return keys;
}

/** What a hunk's actions act on: the picked lines when there are any, else the whole hunk. */
function scopeOf(open: FileChange, hunkIndex: number): { keys: Set<string>; lines: boolean } {
  const picked = pickedIn(hunkIndex);
  return picked.size > 0
    ? { keys: picked, lines: true }
    : { keys: hunkKeys(open, hunkIndex), lines: false };
}

function onSelect(keys: string[], extend: boolean): void {
  const next = new Set(selected.value);
  if (extend || !keys.every((key) => next.has(key))) {
    for (const key of keys) next.add(key);
  } else {
    for (const key of keys) next.delete(key);
  }
  selected.value = next;
}

function stageHunk(hunkIndex: number): void {
  const open = file.value;
  if (!open || list.value === null) return;
  const { keys } = scopeOf(open, hunkIndex);
  void changes.applySelection(list.value === "unstaged" ? "stage" : "unstage", open, keys);
}

function discardHunk(hunkIndex: number): void {
  const open = file.value;
  if (!open) return;
  const { keys, lines } = scopeOf(open, hunkIndex);
  if (lines) emit("discard", { kind: "lines", file: open, keys });
  else emit("discard", { kind: "hunk", file: open, hunkIndex, keys });
}

/** "Reload" on the banner: the failure is dismissed and both lists stream again. */
function reload(): void {
  changes.dismissError();
  changes.load();
}

function fileAction(): void {
  const open = file.value;
  if (!open || list.value === null) return;
  if (list.value === "unstaged") emit("discard", { kind: "files", files: [open] });
  else void changes.unstage([open.path]);
}

/** The banner's sentence: a stale hunk gets its own, a commit its own, the rest git's words. */
const failedMessage = computed(() => {
  const error = changes.actionError;
  const failed = changes.failed;
  if (!error || !failed) return "";
  const stale =
    failed.kind !== "commit" && /patch (does not apply|failed)/.test(error.detail ?? "");
  if (stale) return t("changes.staleHunk", { path: failed.path ?? file.value?.path ?? "" });
  const text = errorText(error);
  const message = t(text.key, text.params);
  return failed.kind === "commit"
    ? t("changes.commitFailed", { message })
    : t("changes.writeFailed", { message });
});

// The picked lines belong to one file of one list; a write reloads the rows under them.
watch(
  () => [changes.selected?.list, changes.selected?.path, changes.busy] as const,
  () => {
    selected.value = new Set();
  },
);

/** Stages, unstages or discards the picked lines (the s, u and Backspace keys). */
function actOnSelection(action: "stage" | "unstage" | "discard"): boolean {
  const open = file.value;
  if (!open || selected.value.size === 0) return false;
  if (action === "discard") {
    if (!partialDiscard.value) return false;
    emit("discard", { kind: "lines", file: open, keys: new Set(selected.value) });
    return true;
  }
  if ((action === "stage") !== (list.value === "unstaged")) return false;
  void changes.applySelection(action, open, new Set(selected.value));
  return true;
}

defineExpose({ actOnSelection, selectedCount });
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col" data-testid="changes-viewer">
    <header
      v-if="!changes.isEmpty"
      class="flex h-panel-header shrink-0 items-center gap-3 border-b border-line px-3 whitespace-nowrap"
    >
      <template v-if="file">
        <span class="flex min-w-0 flex-1 items-center gap-3">
          <DiffPath :path="file.path" data-testid="changes-path" />
          <span v-if="file.isGenerated" class="text-sm text-fg-muted">
            {{ t("detail.generatedLabel") }}
          </span>
          <span v-if="file.isLossy" class="text-sm text-fg-muted" data-testid="changes-lossy">
            {{ t("changes.lossy") }}
          </span>
          <span
            v-if="selectedCount > 0"
            class="text-sm text-fg-secondary"
            data-testid="changes-selected-count"
          >
            {{ t("changes.selectedLines", { n: n(selectedCount) }, selectedCount) }}
          </span>
        </span>
        <DiffStat v-if="!file.isBinary" :added="file.additions" :removed="file.deletions" />
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
          :label="t('review.wholeFile')"
          :icon="UnfoldVertical"
          :pressed="review.wholeFile"
          :keys="wholeFileKeys"
          data-testid="toggle-whole-file"
          @click="() => void review.setWholeFile(!review.wholeFile)"
        />
        <IconButton
          :label="editorLabel"
          :icon="Code"
          :disabled="!opener.canOpen(file)"
          data-testid="open-in-editor"
          @click="() => file && void opener.openFile(file)"
        />
        <Button
          v-if="conflicted"
          variant="ghost"
          :icon="Check"
          :disabled="sequencer.busy"
          data-testid="mark-resolved"
          @click="() => file && void sequencer.markResolved([file.path])"
        >
          {{ t("sequencer.markResolved") }}
        </Button>
        <Button
          v-if="!conflicted"
          variant="ghost"
          :icon="list === 'unstaged' ? Undo2 : Minus"
          :disabled="busy"
          data-testid="file-action"
          @click="fileAction"
        >
          {{ list === "unstaged" ? t("changes.discardFile") : t("changes.unstageFile") }}
        </Button>
      </template>
      <span v-else class="flex-1"></span>
    </header>

    <!-- The banner sits 12px from the header and the panel edges. -->
    <div v-if="changes.actionError" class="p-3" data-testid="changes-failed">
      <ErrorBanner
        :message="failedMessage"
        :output="changes.actionError.detail ?? changes.actionError.message"
        :action="t('changes.reload')"
        open
        @action="reload"
      />
    </div>

    <div
      v-if="changes.loading && !file"
      class="min-h-0 flex-1 overflow-hidden bg-app"
      :data-theme="codeTheme"
      data-testid="changes-diff-loading"
    >
      <SkeletonRow v-for="k in 24" :key="`skeleton-${k}`" :index="k" height="diff" />
    </div>
    <EmptyState
      v-else-if="changes.isEmpty"
      class="flex-1"
      :message="t('changes.emptyViewer')"
      data-testid="changes-viewer-empty"
    />
    <!-- The lists' own failure is their banner; the viewer stays quiet. -->
    <div v-else-if="changes.error" class="flex-1" data-testid="changes-viewer-failed"></div>
    <EmptyState v-else-if="!file" class="flex-1" :message="t('changes.noFile')" />
    <ImageDiff v-else-if="isImage && root && target" :root="root" :target="target" :file="file" />
    <DiffGuard
      v-else-if="guard"
      :file="file"
      :reason="guard"
      :reviewable="false"
      :root="root"
      @reveal="revealed = new Set(revealed).add(file.path)"
    />
    <DiffRows
      v-else
      ref="rows"
      :file="file"
      :hunks="file.hunks"
      :highlighted="true"
      :target="target"
      :selectable="selectable && !busy"
      :selected="selected"
      :root="root"
      @select="onSelect"
    >
      <template #hunkActions="{ hunkIndex }">
        <Button
          variant="ghost"
          :icon="list === 'unstaged' ? Plus : Minus"
          :disabled="busy"
          data-testid="hunk-stage"
          @click="stageHunk(hunkIndex)"
        >
          {{
            list === "unstaged"
              ? pickedIn(hunkIndex).size > 0
                ? t("changes.stageLines")
                : t("changes.stageHunk")
              : pickedIn(hunkIndex).size > 0
                ? t("changes.unstageLines")
                : t("changes.unstageHunk")
          }}
        </Button>
        <Button
          v-if="partialDiscard"
          variant="ghost"
          :icon="Undo2"
          :disabled="busy"
          data-testid="hunk-discard"
          @click="discardHunk(hunkIndex)"
        >
          {{ pickedIn(hunkIndex).size > 0 ? t("changes.discardLines") : t("changes.discardHunk") }}
        </Button>
      </template>
    </DiffRows>
  </section>
</template>
