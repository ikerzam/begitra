<script setup lang="ts">
// The changes screen: the sidebar of graph focus stays, the main area
// is the lists panel with the commit box under it, then the viewer. j and k move the selected
// file through both lists from anywhere on the screen; s, u and Backspace act on the picked
// lines when there are any, else on the selected file; ⌘↵ commits. Discards confirm once in
// the discard dialog, naming the files or the lines and that nothing can
// be recovered.

import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Dialog from "@/components/Dialog.vue";
import type { FileChange } from "@/ipc/schemas";
import { hunkRange } from "@/review/diffRows";
import { baseName } from "@/shell/format";
import PaneResizer from "@/shell/PaneResizer.vue";
import { useShortcut } from "@/shortcuts/useShortcut";
import { useChangesStore } from "@/stores/changes";
import { useSequencerStore } from "@/stores/sequencer";
import { paneLimits, useShellStore } from "@/stores/shell";

import ChangeLists from "./ChangeLists.vue";
import ChangesViewer from "./ChangesViewer.vue";
import CommitBox from "./CommitBox.vue";
import type { DiscardRequest } from "./discard";

const { t, n } = useI18n();
const shell = useShellStore();
const changes = useChangesStore();
const sequencer = useSequencerStore();
const lists = ref<{ focus(): void; moveFile(step: 1 | -1): void } | null>(null);
const viewer = ref<{ actOnSelection(action: "stage" | "unstage" | "discard"): boolean } | null>(
  null,
);
const pending = ref<DiscardRequest | null>(null);
const listsWidth = computed(() => `${shell.paneSizes.files}px`);

/** The dialog's title, body and confirm label for the pending discard. */
const dialog = computed(() => {
  const request = pending.value;
  if (!request) return null;
  if (request.kind === "files") {
    // "The unstaged changes to a and b are lost, and b is deleted: it is not tracked yet."
    // (b untracked); untracked files alone read "b is deleted: it is not tracked yet."
    const tracked = request.files.filter((file) => file.status !== "added");
    const untracked = request.files.filter((file) => file.status === "added");
    const count = request.files.length;
    const names = joinNames(untracked.map((file) => baseName(file.path)));
    let body: string;
    if (tracked.length === 0) {
      body = t("changes.discardDialog.bodyUntracked", { names }, untracked.length);
    } else {
      body = t("changes.discardDialog.bodyFiles", { paths: joinPaths(request.files) });
      body +=
        untracked.length > 0
          ? t("changes.discardDialog.bodyUntrackedClause", { names }, untracked.length)
          : ".";
    }
    return {
      title: t("changes.discardDialog.title", { n: n(count) }, count),
      body: `${body} ${t("changes.discardDialog.cannotRecover")}`,
      confirm: t("changes.discardDialog.confirm", { n: n(count) }, count),
    };
  }
  if (request.kind === "hunk") {
    const hunk = request.file.hunks[request.hunkIndex];
    return {
      title: t("changes.discardDialog.hunkTitle"),
      body: `${t("changes.discardDialog.bodyHunk", {
        range: hunk ? hunkRange(hunk) : "",
        path: request.file.path,
      })} ${t("changes.discardDialog.cannotRecover")}`,
      confirm: t("changes.discardDialog.confirmHunk"),
    };
  }
  const count = request.keys.size;
  return {
    title: t("changes.discardDialog.linesTitle", { n: n(count) }, count),
    body: `${t(
      "changes.discardDialog.bodyLines",
      { n: n(count), path: request.file.path },
      count,
    )} ${t("changes.discardDialog.cannotRecover")}`,
    confirm: t("changes.discardDialog.confirmLines", { n: n(count) }, count),
  };
});

/** Up to three paths in full ("a, b and c"), then "a, b, c and N more". */
function joinPaths(files: FileChange[]): string {
  return joinNames(files.map((file) => file.path));
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length <= 3) {
    return `${names.slice(0, -1).join(", ")} ${t("changes.discardDialog.and")} ${names.at(-1)}`;
  }
  return t("changes.discardDialog.andMore", {
    names: names.slice(0, 3).join(", "),
    n: n(names.length - 3),
  });
}

function askDiscard(request: DiscardRequest): void {
  if (changes.busy !== null || pending.value !== null) return;
  if (request.kind === "files" && request.files.length === 0) return;
  if (request.kind !== "files" && request.keys.size === 0) return;
  pending.value = request;
}

function confirmDiscard(): void {
  const request = pending.value;
  pending.value = null;
  if (!request) return;
  if (request.kind === "files") void changes.discard(request.files);
  else void changes.applySelection("discard", request.file, request.keys);
}

/** s, u, Backspace: the picked lines first, else the selected file of the matching list. */
function actOnSelected(action: "stage" | "unstage" | "discard"): void {
  if (changes.busy !== null || pending.value !== null) return;
  if (viewer.value?.actOnSelection(action)) return;
  const current = changes.selected;
  const file = changes.selectedFile;
  if (!current || !file) return;
  if (action === "stage" && current.list === "unstaged") void changes.stage([file.path]);
  else if (action === "unstage" && current.list === "staged") void changes.unstage([file.path]);
  else if (action === "discard" && current.list === "unstaged") {
    askDiscard({ kind: "files", files: [file] });
  }
}

useShortcut("next-file", () => lists.value?.moveFile(1));
useShortcut("previous-file", () => lists.value?.moveFile(-1));
useShortcut("stage-file", () => actOnSelected("stage"));
useShortcut("unstage-file", () => actOnSelected("unstage"));
useShortcut("discard-file", () => actOnSelected("discard"));
useShortcut("commit", () => void changes.commit());
// r marks the selected file resolved while it is one of the operation's conflicts.
useShortcut("mark-resolved", () => {
  const path = changes.selected?.path;
  if (path && sequencer.conflicts.some((entry) => entry.path === path)) {
    void sequencer.markResolved([path]);
  }
});
// No key of its own: the palette's "Discard all…" runs it through the registry.
useShortcut("discard-all", () => askDiscard({ kind: "files", files: changes.unstaged.files }));

// The lists load on entry and the context with them; a later entry only reloads.
onMounted(() => {
  changes.load();
  void changes.loadContext();
});

// A clean tree that gets its first change, or the lists after a reload: nothing to do here;
// the store keeps the selection. The dialog closes if its file left the lists.
watch(
  () => changes.unstaged.files,
  () => {
    const request = pending.value;
    if (!request || changes.loading) return;
    const listed = new Set(changes.unstaged.files.map((file) => file.path));
    const paths = request.kind === "files" ? request.files.map((f) => f.path) : [request.file.path];
    if (!paths.every((path) => listed.has(path))) pending.value = null;
  },
);

defineExpose({
  focusLists: () => {
    void nextTick(() => lists.value?.focus());
  },
});
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1" data-testid="changes-screen">
    <div
      class="flex shrink-0 flex-col border-r border-line"
      :style="{ width: listsWidth }"
      data-testid="changes-panel"
    >
      <ChangeLists ref="lists" @discard="(files) => askDiscard({ kind: 'files', files })" />
      <CommitBox />
    </div>
    <PaneResizer
      :size="shell.paneSizes.files"
      :min="paneLimits.files.min"
      :max="paneLimits.files.max"
      :label="t('changes.title')"
      @resize="(px) => void shell.setPaneSize('files', px)"
    />
    <ChangesViewer ref="viewer" @discard="askDiscard" />
    <Dialog
      v-if="dialog"
      :title="dialog.title"
      :body="dialog.body"
      :confirm-label="dialog.confirm"
      variant="destructive"
      data-testid="discard-dialog"
      @confirm="confirmDiscard"
      @cancel="pending = null"
    />
  </div>
</template>
