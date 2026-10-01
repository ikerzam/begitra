<script setup lang="ts">
// The Notes block of the review rail: one note per file of the target (path in mono, the
// text), "Add note" for the open file, "Copy as Markdown" for them all, and an inline editor
// to write, change or delete one.

import { Copy, Pencil, Plus, Trash2 } from "@lucide/vue";
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import IconButton from "@/components/IconButton.vue";
import Textarea from "@/components/Textarea.vue";
import { useReviewStore } from "@/stores/review";

import { useNotesExport } from "./useNotesExport";

const { t } = useI18n();
const review = useReviewStore();
const { canCopy, copyNotes } = useNotesExport();

const editing = ref<string | null>(null);
const draft = ref("");
const editor = ref<{ $el: HTMLTextAreaElement } | null>(null);

const notes = computed(() =>
  [...review.notes.entries()]
    .map(([path, text]) => ({ path, text }))
    .sort((a, b) => a.path.localeCompare(b.path)),
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
  <div class="flex flex-col gap-2 border-t border-line px-3 pt-3" data-testid="notes-block">
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
      data-testid="note"
    >
      <div class="flex items-center gap-2">
        <span class="min-w-0 flex-1 truncate font-mono text-mono-sm text-fg-secondary">
          {{ note.path }}
        </span>
        <IconButton
          :label="t('review.editNote')"
          :icon="Pencil"
          @click="() => void edit(note.path)"
        />
        <IconButton
          :label="t('review.deleteNote')"
          :icon="Trash2"
          data-testid="delete-note"
          @click="remove(note.path)"
        />
      </div>
      <p class="text-md whitespace-pre-wrap text-fg select-text">{{ note.text }}</p>
    </div>
  </div>
</template>
