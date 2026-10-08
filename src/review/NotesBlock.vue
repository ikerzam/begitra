<script setup lang="ts">
// The Notes block of the review rail: one note per file of the target (its path, the folder
// truncating first, and the text), "Add note" for the open file, "Copy as Markdown" for them
// all, and an inline editor to write, change or delete one. Open notes come first, then the
// ones an agent resolved: their text dimmed, "Resolved" under it with the agent's reply as a
// quote, and Reopen after edit and delete, which hands the focus to the note's edit button.

import { CircleCheck, Copy, Pencil, Plus, RotateCcw, Trash2 } from "@lucide/vue";
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import IconButton from "@/components/IconButton.vue";
import Textarea from "@/components/Textarea.vue";
import { useReviewStore } from "@/stores/review";

import DiffPath from "./DiffPath.vue";
import { useNotesExport } from "./useNotesExport";

const { t } = useI18n();
const review = useReviewStore();
const { canCopy, copyNotes } = useNotesExport();

const editing = ref<string | null>(null);
const draft = ref("");
const editor = ref<{ $el: HTMLTextAreaElement } | null>(null);
const block = ref<HTMLElement | null>(null);

/** Open notes first, then the resolved ones, each by path. */
const notes = computed(() =>
  [...review.notes.entries()]
    .map(([path, text]) => ({ path, text, resolution: review.resolutions.get(path) }))
    .sort(
      (a, b) =>
        Number(a.resolution !== undefined) - Number(b.resolution !== undefined) ||
        a.path.localeCompare(b.path),
    ),
);
const openPath = computed(() => review.selectedPath);
const canAdd = computed(() => openPath.value !== null && !review.notes.has(openPath.value));

async function edit(path: string): Promise<void> {
  editing.value = path;
  draft.value = review.notes.get(path) ?? "";
  await nextTick();
  editor.value?.$el.focus();
}

function save(): void {
  const path = editing.value;
  if (path === null) return;
  review.setNote(path, draft.value);
  editing.value = null;
  draft.value = "";
}

function cancel(): void {
  editing.value = null;
  draft.value = "";
}

/** Reopens the note on `path`; its Reopen leaves with the resolution, so the focus goes to the
 * note's edit button rather than to the page's body. */
async function reopen(path: string): Promise<void> {
  review.reopenNote(path);
  await nextTick();
  const note = [...(block.value?.querySelectorAll<HTMLElement>("[data-testid='note']") ?? [])].find(
    (element) => element.dataset["path"] === path,
  );
  note?.querySelector<HTMLElement>("[data-testid='edit-note']")?.focus();
}

function remove(path: string): void {
  review.setNote(path, null);
  if (editing.value === path) cancel();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    cancel();
  } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    save();
  }
}
</script>

<template>
  <div
    ref="block"
    class="flex flex-col gap-2 border-t border-line px-3 pt-3"
    data-testid="notes-block"
  >
    <div class="flex items-center justify-between">
      <h3 class="text-lg font-semibold text-fg">{{ t("review.notes") }}</h3>
      <div class="flex items-center gap-1">
        <IconButton
          :icon="Copy"
          :label="t('review.copyNotes')"
          :disabled="!canCopy"
          data-testid="copy-notes"
          @click="copyNotes()"
        />
        <IconButton
          :label="t('review.addNote')"
          :icon="Plus"
          :disabled="!canAdd"
          data-testid="add-note"
          @click="openPath && edit(openPath)"
        />
      </div>
    </div>
    <div v-if="editing !== null" class="flex flex-col gap-2" data-testid="note-editor">
      <span class="truncate font-mono text-mono-sm text-fg-secondary">{{ editing }}</span>
      <Textarea
        ref="editor"
        v-model="draft"
        :placeholder="t('review.notePlaceholder')"
        @keydown="onKeydown"
      />
      <div class="flex items-center gap-2">
        <Button variant="primary" data-testid="save-note" @click="save">
          {{ t("review.saveNote") }}
        </Button>
        <Button variant="ghost" @click="cancel">{{ t("dialog.cancel") }}</Button>
      </div>
    </div>
    <p v-if="notes.length === 0 && editing === null" class="text-sm text-fg-muted">
      {{ t("review.noNotes") }}
    </p>
    <div
      v-for="note in notes"
      :key="note.path"
      class="group flex flex-col gap-1"
      :data-path="note.path"
      data-testid="note"
    >
      <div class="flex items-center gap-2">
        <DiffPath :path="note.path" :muted="note.resolution !== undefined" class="flex-1" />
        <IconButton
          :label="t('review.editNote')"
          :icon="Pencil"
          data-testid="edit-note"
          @click="() => void edit(note.path)"
        />
        <IconButton
          :label="t('review.deleteNote')"
          :icon="Trash2"
          data-testid="delete-note"
          @click="remove(note.path)"
        />
        <IconButton
          v-if="note.resolution"
          :label="t('review.reopenNote')"
          :icon="RotateCcw"
          data-testid="reopen-note"
          @click="() => void reopen(note.path)"
        />
      </div>
      <p
        class="text-sm whitespace-pre-wrap select-text"
        :class="note.resolution ? 'text-fg-muted' : 'text-fg'"
      >
        {{ note.text }}
      </p>
      <template v-if="note.resolution">
        <span
          class="flex items-center gap-1 text-sm font-medium text-reviewed"
          data-testid="note-resolved"
        >
          <CircleCheck :size="14" :stroke-width="1.5" aria-hidden="true" />
          {{ t("review.noteResolvedTag") }}
        </span>
        <p
          v-if="note.resolution.reply !== ''"
          class="border-l-2 border-line-strong pl-2 text-sm whitespace-pre-wrap text-fg-secondary select-text"
          data-testid="note-reply"
        >
          {{ note.resolution.reply }}
        </p>
      </template>
    </div>
  </div>
</template>
