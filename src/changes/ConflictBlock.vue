<script setup lang="ts">
// One conflict block of a conflicted file: its head ("Conflict 2 of 3", the line its first
// marker is on, and "Use main's", "Use develop's", "Both", "Edit"), up to three lines of the file
// before and after it, the current side's lines under its branch, the base's when the markers
// carry one, and the incoming side's, long lines wrapped and every line selectable; or, while it
// is edited, a plain text field holding both sides without the markers, with Apply (Ctrl or ⌘
// Enter) and Cancel (Esc).

import { ArrowLeftToLine, ArrowRightToLine, GitMerge, Pencil } from "@lucide/vue";
import { computed, nextTick, onMounted, ref, useId, useTemplateRef, watch } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import DiffRow from "@/components/DiffRow.vue";
import LaneDot from "@/components/LaneDot.vue";
import { laneBgClass } from "@/components/lanes";
import type { BlockSide, ConflictBlock, ConflictText, DiffLine } from "@/ipc/schemas";
import LineContent from "@/review/LineContent.vue";
import { formatShortcut } from "@/shortcuts/platform";
import { shortcutRegistry } from "@/shortcuts/registry";

/** How the block names a side: its branch (or commit), the button's words, its lane. */
export interface SideNames {
  name: string;
  use: string;
  /** The branch's lane colour; null for a side that is no branch. */
  lane: number | null;
  /** The name is a commit's hash, which the interface sets in mono. */
  hash: boolean;
}

const props = defineProps<{
  text: ConflictText;
  block: ConflictBlock;
  index: number;
  total: number;
  /** The file's lines shown before and after the block: `[from, to)`. */
  before: [number, number];
  after: [number, number];
  ours: SideNames;
  theirs: SideNames;
  focused: boolean;
  editing: boolean;
  /** Another block is being edited: this one waits. */
  waiting: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{
  resolve: [kind: "ours" | "theirs" | "both"];
  edit: [];
  apply: [];
  cancel: [];
  focus: [];
}>();
const draft = defineModel<string>("draft", { default: "" });

const { t } = useI18n();
const root = ref<HTMLElement | null>(null);
const head = ref<HTMLElement | null>(null);
const field = ref<HTMLTextAreaElement | null>(null);
const editButton = useTemplateRef<{ $el: HTMLElement }>("editButton");
const titleId = useId();
const hintId = useId();

/** A file's line as the diff's rows draw it. */
function lineOf(number: number, code: string): DiffLine {
  return {
    kind: "context",
    oldNumber: null,
    newNumber: number,
    text: code,
    spans: [],
    noNewline: false,
  };
}
function lines(range: [number, number]): DiffLine[] {
  return props.text.lines
    .slice(range[0], range[1])
    .map((code, offset) => lineOf(range[0] + offset + 1, code));
}
function sideLines(side: BlockSide): DiffLine[] {
  return lines([side.start, side.end]);
}

const applyKeys = computed(() => formatShortcut("mod+enter", shortcutRegistry().platform));
const actionsOff = computed(() => props.busy || props.waiting);

/** Ctrl Enter (⌘ Enter) applies and Esc leaves the block as it was, from the field or its
 * buttons. */
function onEditorKeydown(event: KeyboardEvent): void {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    event.stopPropagation();
    emit("apply");
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    emit("cancel");
  }
}

/** The field takes the focus when the block turns into it. */
watch(
  () => props.editing,
  async (editing) => {
    if (!editing) return;
    await nextTick();
    field.value?.focus();
  },
);
watch(
  () => props.focused,
  (focused) => {
    if (focused) head.value?.scrollIntoView?.({ block: "nearest" });
  },
);
onMounted(() => {
  if (props.editing) field.value?.focus();
});

/** The block itself, as n and p move to it. */
function focus(): void {
  root.value?.focus({ preventScroll: true });
  head.value?.scrollIntoView?.({ block: "nearest" });
}
/** The Edit button, where the focus goes back once an edit ends without a write. */
function focusEdit(): void {
  editButton.value?.$el.focus();
}

defineExpose({ focus, focusEdit });
</script>

<template>
  <div
    ref="root"
    role="group"
    tabindex="-1"
    class="shrink-0 overflow-hidden rounded-md border outline-none"
    :class="props.focused ? 'border-focus' : 'border-line-strong'"
    :aria-labelledby="titleId"
    data-testid="conflict-block"
    @focusin="emit('focus')"
    @mousedown="emit('focus')"
  >
    <header
      ref="head"
      class="flex min-h-panel-header flex-wrap items-center gap-x-2 border-b border-line py-1 pl-3 pr-2"
    >
      <span :id="titleId" class="whitespace-nowrap text-md font-medium text-fg">
        {{ t("conflictBlocks.block", { n: props.index + 1, total: props.total }) }}
      </span>
      <span class="whitespace-nowrap text-sm text-fg-muted">
        {{ t("conflictBlocks.line", { line: props.block.start + 1 }) }}
      </span>
      <span class="flex-1"></span>
      <span v-if="props.editing" class="min-w-0 truncate text-sm text-fg-muted">
        {{ t("conflictBlocks.editing", { ours: props.ours.name, theirs: props.theirs.name }) }}
      </span>
      <div v-else class="flex min-w-0 flex-wrap items-center justify-end">
        <Button
          variant="ghost"
          class="max-w-full"
          :icon="ArrowLeftToLine"
          :disabled="actionsOff"
          :tooltip="props.ours.use"
          data-testid="conflict-block-ours"
          @click="emit('resolve', 'ours')"
          ><span class="min-w-0 truncate">{{ props.ours.use }}</span></Button
        >
        <Button
          variant="ghost"
          class="max-w-full"
          :icon="ArrowRightToLine"
          :disabled="actionsOff"
          :tooltip="props.theirs.use"
          data-testid="conflict-block-theirs"
          @click="emit('resolve', 'theirs')"
          ><span class="min-w-0 truncate">{{ props.theirs.use }}</span></Button
        >
        <Button
          variant="ghost"
          :icon="GitMerge"
          :disabled="actionsOff"
          data-testid="conflict-block-both"
          @click="emit('resolve', 'both')"
          >{{ t("conflictBlocks.both") }}</Button
        >
        <Button
          ref="editButton"
          variant="ghost"
          :icon="Pencil"
          :disabled="actionsOff"
          :unavailable="props.text.utf8 ? undefined : t('conflictBlocks.notUtf8')"
          data-testid="conflict-block-edit"
          @click="emit('edit')"
          >{{ t("conflictBlocks.edit") }}</Button
        >
      </div>
    </header>
    <div v-if="props.before[1] > props.before[0]" class="pt-1">
      <DiffRow
        v-for="line in lines(props.before)"
        :key="`before-${line.newNumber}`"
        class="h-auto min-h-row-diff"
        :new-number="line.newNumber ?? undefined"
      >
        <LineContent :line="line" wrap />
      </DiffRow>
    </div>
    <div
      v-if="props.editing"
      class="conflict-editor flex flex-col gap-2 pb-3 pr-3 pt-2"
      @keydown="onEditorKeydown"
    >
      <textarea
        ref="field"
        v-model="draft"
        class="conflict-field rounded-sm border border-line-strong bg-app px-2 py-1 font-mono text-code text-fg"
        :rows="Math.max(3, draft.split('\n').length)"
        :readonly="props.busy"
        spellcheck="false"
        :aria-label="
          t('conflictBlocks.editing', { ours: props.ours.name, theirs: props.theirs.name })
        "
        :aria-describedby="hintId"
        data-testid="conflict-block-field"
      ></textarea>
      <div class="flex flex-wrap items-center gap-2">
        <span :id="hintId" class="text-sm text-fg-muted">
          {{ t("conflictBlocks.editHint", { keys: applyKeys }) }}
        </span>
        <span class="flex-1"></span>
        <Button variant="ghost" data-testid="conflict-block-cancel" @click="emit('cancel')">
          {{ t("conflictBlocks.cancel") }}
        </Button>
        <Button
          variant="primary"
          :disabled="props.busy"
          data-testid="conflict-block-apply"
          @click="emit('apply')"
        >
          {{ t("conflictBlocks.apply") }}
        </Button>
      </div>
    </div>
    <template v-else>
      <div class="relative bg-raised" data-testid="conflict-block-side-ours">
        <span
          class="conflict-edge absolute inset-y-0 left-0"
          :class="props.ours.lane === null ? 'bg-line-strong' : laneBgClass(props.ours.lane)"
        ></span>
        <div class="conflict-label flex h-5 items-center gap-2 text-sm">
          <LaneDot v-if="props.ours.lane !== null" :lane="props.ours.lane" />
          <span class="font-medium text-fg" :class="{ 'font-mono': props.ours.hash }">{{
            props.ours.name
          }}</span>
          <span class="text-fg-muted">{{ t("conflictBlocks.current") }}</span>
        </div>
        <DiffRow
          v-for="line in sideLines(props.block.ours)"
          :key="`ours-${line.newNumber}`"
          class="h-auto min-h-row-diff"
          :new-number="line.newNumber ?? undefined"
        >
          <LineContent :line="line" wrap />
        </DiffRow>
      </div>
      <div v-if="props.block.base" data-testid="conflict-block-side-base">
        <div class="conflict-label flex h-5 items-center gap-2 text-sm text-fg-muted">
          {{ t("conflictBlocks.base") }}
        </div>
        <DiffRow
          v-for="line in sideLines(props.block.base)"
          :key="`base-${line.newNumber}`"
          class="h-auto min-h-row-diff"
          :new-number="line.newNumber ?? undefined"
        >
          <span class="text-fg-muted"><LineContent :line="line" wrap /></span>
        </DiffRow>
      </div>
      <div class="relative bg-raised" data-testid="conflict-block-side-theirs">
        <span
          class="conflict-edge absolute inset-y-0 left-0"
          :class="props.theirs.lane === null ? 'bg-line-strong' : laneBgClass(props.theirs.lane)"
        ></span>
        <div class="conflict-label flex h-5 items-center gap-2 text-sm">
          <LaneDot v-if="props.theirs.lane !== null" :lane="props.theirs.lane" />
          <span class="font-medium text-fg" :class="{ 'font-mono': props.theirs.hash }">{{
            props.theirs.name
          }}</span>
          <span class="text-fg-muted">{{ t("conflictBlocks.incoming") }}</span>
        </div>
        <DiffRow
          v-for="line in sideLines(props.block.theirs)"
          :key="`theirs-${line.newNumber}`"
          class="h-auto min-h-row-diff"
          :new-number="line.newNumber ?? undefined"
        >
          <LineContent :line="line" wrap />
        </DiffRow>
      </div>
    </template>
    <div v-if="props.after[1] > props.after[0]" class="pb-1">
      <DiffRow
        v-for="line in lines(props.after)"
        :key="`after-${line.newNumber}`"
        class="h-auto min-h-row-diff"
        :new-number="line.newNumber ?? undefined"
      >
        <LineContent :line="line" wrap />
      </DiffRow>
    </div>
  </div>
</template>

<style scoped>
/* The side's 2px edge in its branch's lane colour; off the spacing scale. */
.conflict-edge {
  width: 2px;
}
/* The side's label and the edit field start where the code does: the two 44px number cells
   and the 22px marker of the diff's rows. */
.conflict-label,
.conflict-editor {
  padding-left: calc(var(--diff-gutter-w, 44px) * 2 + var(--diff-marker-w, 22px));
}
/* The field's tabs take the diff's width, as the rows above it do. */
.conflict-field {
  resize: vertical;
  tab-size: var(--diff-tab-width, 4);
}
</style>
