<script setup lang="ts">
// The changes screen: the sidebar of graph focus stays, the main area is the lists panel with the
// commit box under it, then the viewer. j and k move the selected file through both lists from
// anywhere on the screen; s, u and Backspace act on the picked lines when there are any, else on
// the selected file; ⌘↵ commits. Discards confirm once in the discard dialog, naming the files or
// the lines and that Undo in the notification brings them back.

import { computed, nextTick, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import Dialog from "@/components/Dialog.vue";
import PaneResizer from "@/shell/PaneResizer.vue";
import { useShortcut } from "@/shortcuts/useShortcut";
import { useChangesStore } from "@/stores/changes";
import { useSequencerStore } from "@/stores/sequencer";
import { paneLimits, useShellStore } from "@/stores/shell";

import ChangeLists from "./ChangeLists.vue";
import ChangesViewer from "./ChangesViewer.vue";
import CommitBox from "./CommitBox.vue";
import IgnoreDialog from "./IgnoreDialog.vue";
import type { DiscardRequest } from "./discard";
import { useCommitAndPush } from "./useCommitAndPush";
import { useDiscardDialog } from "./useDiscardDialog";
import { useIgnoreDialog } from "./useIgnoreDialog";

const { t } = useI18n();
const shell = useShellStore();
const changes = useChangesStore();
const sequencer = useSequencerStore();
const lists = ref<{ focus(): void; moveFile(step: 1 | -1): boolean } | null>(null);
const viewer = ref<{ actOnSelection(action: "stage" | "unstage" | "discard"): boolean } | null>(
  null,
);
const discard = useDiscardDialog({ refocus: () => lists.value?.focus() });
const ignore = useIgnoreDialog({ refocus: () => lists.value?.focus() });
const pushing = useCommitAndPush();
const listsWidth = computed(() => `${shell.paneSizes.files}px`);

function askDiscard(request: DiscardRequest): void {
  discard.ask(changes, request);
}

/** s, u, Backspace: the picked lines first, else the selected file of the matching list. */
function actOnSelected(action: "stage" | "unstage" | "discard"): void {
  if (changes.blocking || discard.pending.value !== null || ignore.pending.value !== null) return;
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
useShortcut("commit-push", () => void pushing.commitAndPush(changes));
// r marks the selected file resolved while it is one of the operation's conflicts.
useShortcut("mark-resolved", () => {
  const path = changes.selected?.path;
  if (path && sequencer.conflicts.some((entry) => entry.path === path)) {
    void sequencer.markResolved([path]);
  }
});
// No key of its own: the palette's "Discard all…" runs it through the registry.
useShortcut("discard-all", () => askDiscard({ kind: "files", files: changes.unstaged.files }));

// The lists load once the repository shows its history; an entry loads them only when they are
// not loaded (or failed), and the commit context with them.
onMounted(() => {
  changes.ensureLoaded();
  void changes.loadContext();
});

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
      <ChangeLists
        ref="lists"
        @discard="(files) => askDiscard({ kind: 'files', files })"
        @ignore="(file) => ignore.ask(changes, file)"
      />
      <CommitBox @push-left="lists?.focus()" />
    </div>
    <PaneResizer
      :size="shell.paneSizes.files"
      :min="paneLimits.files.min"
      :max="paneLimits.files.max"
      :label="t('changes.title')"
      @resize="(px) => void shell.setPaneSize('files', px)"
      @reset="() => void shell.resetPaneSize('files')"
    />
    <ChangesViewer ref="viewer" @discard="askDiscard" />
    <Dialog
      v-if="discard.dialog.value"
      :title="discard.dialog.value.title"
      :body="discard.dialog.value.body"
      :confirm-label="discard.dialog.value.confirm"
      variant="destructive"
      data-testid="discard-dialog"
      @confirm="void discard.confirm()"
      @cancel="discard.cancel()"
    >
      <pre
        v-if="discard.dialog.value.output"
        class="rounded-sm border border-line bg-app px-2 py-1 font-mono text-code break-all whitespace-pre-wrap text-fg-secondary"
        data-testid="discard-reason"
        >{{ discard.dialog.value.output }}</pre>
    </Dialog>
    <IgnoreDialog
      v-if="ignore.pending.value"
      v-model:rule="ignore.rule.value"
      v-model:place="ignore.place.value"
      :path="ignore.path.value"
      :repository="ignore.repository.value"
      :rules="ignore.rules.value"
      :line="ignore.line.value"
      @confirm="ignore.confirm()"
      @cancel="ignore.cancel()"
    />
  </div>
</template>
