<script setup lang="ts">
// The two lists of the changes screen: Unstaged with "Stage all" and
// "Discard all…" in its header, Staged with "Unstage all", flat rows with the status letter
// (the "?" of an untracked file), the path and the stats. For the keyboard the two lists are
// one: j/k and the arrows move through both, Enter opens the row's menu, s, u and Backspace
// act on the selected row (the layout binds them), and the selected row is the tab stop.
// Skeleton rows while the diffs stream, the empty sentence on a clean tree.

import { Check, CheckCheck, Code, Minus, Plus, Terminal, Undo2 } from "@lucide/vue";
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import ContextMenu from "@/components/ContextMenu.vue";
import ContextMenuItem from "@/components/ContextMenuItem.vue";
import EmptyState from "@/components/EmptyState.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import IconButton from "@/components/IconButton.vue";
import PanelHeader from "@/components/PanelHeader.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import TreeRow from "@/components/TreeRow.vue";
import type { FileStatus } from "@/components/types";
import { statusOf } from "@/detail/groupFiles";
import type { Conflict, FileChange } from "@/ipc/schemas";
import { errorText } from "@/shell/errorMessage";
import { useShortcutHint } from "@/shortcuts/useShortcut";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import { useExternal } from "@/shell/useExternal";
import { useChangesStore, type ChangeList } from "@/stores/changes";
import { useSequencerStore } from "@/stores/sequencer";

const emit = defineEmits<{
  /** "Discard…" on rows, or "Discard all…": the layout confirms. */
  discard: [files: FileChange[]];
}>();

const { t } = useI18n();
const changes = useChangesStore();
const sequencer = useSequencerStore();
const external = useExternal();
const panel = ref<HTMLElement | null>(null);
const menu = ref<{ list: ChangeList; file: FileChange; x: number; y: number } | null>(null);
/** The conflict row whose menu is open. */
const conflictMenu = ref<{ conflict: Conflict; x: number; y: number } | null>(null);
const resolveHint = useShortcutHint("mark-resolved");
/** Whether the focus was last seen inside the panel (a row that leaves the DOM takes it). */
let focusInside = false;
const stageHint = useShortcutHint("stage-file");
const unstageHint = useShortcutHint("unstage-file");
const discardHint = useShortcutHint("discard-file");

interface Row {
  list: ChangeList | "conflicts";
  file: FileChange;
}

/** A conflict as a row: the working tree's entry of its path, or a bare one to name it. */
function conflictRow(conflict: Conflict): Row {
  const file = changes.unstaged.files.find((entry) => entry.path === conflict.path) ?? {
    status: "unmerged",
    path: conflict.path,
    oldPath: null,
    similarity: null,
    additions: 0,
    deletions: 0,
    hunks: [],
    isBinary: false,
    isLarge: false,
    isGenerated: false,
    isTest: false,
    isLossy: false,
    oldId: null,
    newId: null,
  };
  return { list: "conflicts", file };
}

/** The three lists as one sequence, for the keyboard: conflicts first. */
const rows = computed<Row[]>(() => [
  ...sequencer.conflicts.map(conflictRow),
  ...changes.unstaged.files.map((file) => ({ list: "unstaged" as const, file })),
  ...changes.staged.files.map((file) => ({ list: "staged" as const, file })),
]);
const count = computed(() => rows.value.length);
/** The conflict row the selection stands on, when the file was picked from that list. */
const selectedConflict = ref<string | null>(null);
const selectedIndex = computed({
  get: () => {
    const current = changes.selected;
    if (!current) return -1;
    if (selectedConflict.value === current.path && current.list === "unstaged") {
      const at = rows.value.findIndex(
        (row) => row.list === "conflicts" && row.file.path === current.path,
      );
      if (at >= 0) return at;
    }
    return rows.value.findIndex(
      (row) => row.list === current.list && row.file.path === current.path,
    );
  },
  set: (index: number) => {
    const row = rows.value[index];
    if (row) selectRow(row);
  },
});

/** A conflict opens its working-tree entry in the viewer (the unstaged list has it). */
function selectRow(row: Row): void {
  if (row.list === "conflicts") {
    selectedConflict.value = row.file.path;
    changes.select("unstaged", row.file.path);
  } else {
    selectedConflict.value = null;
    changes.select(row.list, row.file.path);
  }
}

const tabStop = computed(() => (selectedIndex.value >= 0 ? selectedIndex.value : 0));
const showSkeletons = (list: ChangeList) =>
  changes[list].loading && changes[list].files.length === 0;
const showEmpty = computed(() => changes.isEmpty);
const showLists = computed(() => !showEmpty.value && !changes.error);
/** A diff that failed: the sentence over git's words, with "Try again". */
const loadFailed = computed(() => {
  const error = changes.error;
  if (!error) return "";
  const text = errorText(error);
  return t("changes.loadFailed", { message: t(text.key, text.params) });
});

function rowElement(index: number): Element | null | undefined {
  const row = rows.value[index];
  if (!row) return null;
  const path = row.file.path.replace(/["\\]/g, "\\$&");
  return panel.value?.querySelector(`[data-list="${row.list}"][data-path="${path}"]`);
}

/** The selected row of a conflict or a file: the rows share the sequence. */
function isSelected(list: Row["list"], path: string): boolean {
  const current = changes.selected;
  if (!current || current.path !== path) return false;
  if (list === "conflicts") return current.list === "unstaged" && selectedConflict.value === path;
  if (list === "unstaged") return current.list === "unstaged" && selectedConflict.value !== path;
  return current.list === list;
}

const navigation = useListNavigation({
  count,
  selected: selectedIndex,
  rowElement,
  onActivate: (index) => {
    const row = rows.value[index];
    const rect = rowElement(index)?.getBoundingClientRect();
    if (row) openMenu(row, rect ? rect.left + MENU_OFFSET_X : 0, rect ? rect.bottom : 0);
  },
});

/** The menu opens under the row, past the status letter, where the graph opens its own. */
const MENU_OFFSET_X = 116;

/** The letter of a row: an added file of the unstaged list is untracked. */
function statusLetter(list: ChangeList, file: FileChange): FileStatus {
  const status = statusOf(file.status);
  return list === "unstaged" && status === "added" ? "untracked" : status;
}

function openMenu(row: Row, x: number, y: number): void {
  selectRow(row);
  if (row.list === "conflicts") {
    const conflict = sequencer.conflicts.find((entry) => entry.path === row.file.path);
    if (conflict) conflictMenu.value = { conflict, x, y };
    return;
  }
  menu.value = { list: row.list, file: row.file, x, y };
}

function closeConflictMenu(): void {
  conflictMenu.value = null;
  navigation.focus();
}

function conflictAction(action: "resolve" | "editor" | "terminal"): void {
  const current = conflictMenu.value;
  if (!current) return;
  conflictMenu.value = null;
  if (action === "resolve") void sequencer.markResolved([current.conflict.path]);
  else if (action === "editor") void external.openEditor();
  else void external.openTerminal();
}

function onContextMenu(row: Row, event: MouseEvent): void {
  event.preventDefault();
  openMenu(row, event.clientX, event.clientY);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    const row = rows.value[selectedIndex.value];
    if (!row) return;
    event.preventDefault();
    const rect = rowElement(selectedIndex.value)?.getBoundingClientRect();
    openMenu(row, rect ? rect.left + MENU_OFFSET_X : 0, rect ? rect.bottom : 0);
    return;
  }
  navigation.onKeydown(event);
}

function closeMenu(): void {
  menu.value = null;
  navigation.focus();
}

function menuAction(action: "stage" | "unstage" | "discard"): void {
  const current = menu.value;
  if (!current) return;
  menu.value = null;
  if (action === "stage") void changes.stage([current.file.path]);
  else if (action === "unstage") void changes.unstage([current.file.path]);
  else emit("discard", [current.file]);
}

/** j/k from anywhere on the screen: moves the selection through both lists. */
function moveFile(step: 1 | -1): void {
  navigation.moveBy(step);
}

function onFocusIn(): void {
  focusInside = true;
}

function onFocusOut(event: FocusEvent): void {
  const next = event.relatedTarget;
  if (next instanceof Node && panel.value?.contains(next)) return;
  focusInside = false;
}

// A write reloads the lists and the selected row leaves the DOM with the focus: the row
// that took its place gets it back, so Enter, Space and the keys keep working.
watch(
  () => changes.selected,
  () => {
    if (!focusInside || menu.value || conflictMenu.value) return;
    void nextTick(() => {
      const active = document.activeElement;
      if (active && active !== document.body && panel.value?.contains(active)) return;
      navigation.focus();
    });
  },
);

defineExpose({ focus: navigation.focus, moveFile });
</script>

<template>
  <section
    ref="panel"
    class="flex min-h-0 min-w-0 flex-1 flex-col"
    data-testid="change-lists"
    @keydown="onKeydown"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
  >
    <template v-if="showEmpty">
      <PanelHeader :title="t('changes.title')" :count="0" />
      <EmptyState class="flex-1" :message="t('changes.empty')" data-testid="changes-empty" />
    </template>
    <div v-else class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="changes.error" class="p-3" data-testid="changes-load-failed">
        <ErrorBanner
          :message="loadFailed"
          :output="changes.error.detail ?? changes.error.message"
          :action="t('changes.tryAgain')"
          @action="changes.load()"
        />
      </div>
      <template v-if="sequencer.conflicts.length > 0">
        <PanelHeader :title="t('sequencer.conflicts')" :count="sequencer.conflicts.length">
          <template #actions>
            <IconButton
              :label="t('sequencer.markAllResolved')"
              :icon="CheckCheck"
              :disabled="sequencer.busy"
              data-testid="resolve-all"
              @click="() => void sequencer.markResolved(sequencer.conflicts.map((c) => c.path))"
            />
          </template>
        </PanelHeader>
        <div role="tree" class="py-1" data-testid="conflicts-list">
          <TreeRow
            v-for="(conflict, index) in sequencer.conflicts"
            :key="conflict.path"
            :name="conflict.path"
            status="unmerged"
            :meta="t(`sequencer.kinds.${conflict.kind}`)"
            :selected="isSelected('conflicts', conflict.path)"
            :tab-stop="tabStop === index"
            data-list="conflicts"
            :data-path="conflict.path"
            :data-tooltip="conflict.path"
            @select="selectRow(conflictRow(conflict))"
            @contextmenu="(event: MouseEvent) => onContextMenu(conflictRow(conflict), event)"
          />
        </div>
      </template>
      <PanelHeader
        :title="t('changes.unstaged')"
        :count="
          changes.unstaged.loading && changes.unstagedCount === 0
            ? undefined
            : changes.unstagedCount
        "
      >
        <template #actions>
          <IconButton
            :label="t('changes.stageAll')"
            :icon="Plus"
            :disabled="changes.busy !== null || changes.unstagedCount === 0"
            data-testid="stage-all"
            @click="() => void changes.stageAll()"
          />
          <IconButton
            :label="t('changes.discardAll')"
            :icon="Undo2"
            :disabled="changes.busy !== null || changes.unstagedCount === 0"
            data-testid="discard-all"
            @click="emit('discard', changes.unstaged.files)"
          />
        </template>
      </PanelHeader>
      <div v-if="showLists" role="tree" class="py-1" data-testid="unstaged-list">
        <template v-if="showSkeletons('unstaged')">
          <SkeletonRow v-for="n in 5" :key="n" :index="n" height="tree" />
        </template>
        <TreeRow
          v-for="(file, index) in changes.unstaged.files"
          :key="file.path"
          :name="file.path"
          :status="statusLetter('unstaged', file)"
          :added="file.isBinary ? undefined : file.additions"
          :removed="file.isBinary ? undefined : file.deletions"
          :generated="file.isGenerated"
          :binary="file.isBinary"
          :selected="isSelected('unstaged', file.path)"
          :tab-stop="tabStop === sequencer.conflicts.length + index"
          :aria-disabled="changes.busy !== null || undefined"
          data-list="unstaged"
          :data-path="file.path"
          :data-tooltip="file.path"
          @select="changes.select('unstaged', file.path)"
          @contextmenu="(event: MouseEvent) => onContextMenu({ list: 'unstaged', file }, event)"
        />
      </div>
      <PanelHeader
        :title="t('changes.staged')"
        :count="
          changes.staged.loading && changes.stagedCount === 0 ? undefined : changes.stagedCount
        "
      >
        <template #actions>
          <IconButton
            :label="t('changes.unstageAll')"
            :icon="Minus"
            :disabled="changes.busy !== null || changes.stagedCount === 0"
            data-testid="unstage-all"
            @click="() => void changes.unstageAll()"
          />
        </template>
      </PanelHeader>
      <div v-if="showLists" role="tree" class="py-1" data-testid="staged-list">
        <template v-if="showSkeletons('staged')">
          <SkeletonRow v-for="n in 2" :key="n" :index="n + 5" height="tree" />
        </template>
        <TreeRow
          v-for="(file, index) in changes.staged.files"
          :key="file.path"
          :name="file.path"
          :status="statusLetter('staged', file)"
          :added="file.isBinary ? undefined : file.additions"
          :removed="file.isBinary ? undefined : file.deletions"
          :generated="file.isGenerated"
          :binary="file.isBinary"
          :selected="isSelected('staged', file.path)"
          :tab-stop="tabStop === sequencer.conflicts.length + changes.unstagedCount + index"
          :aria-disabled="changes.busy !== null || undefined"
          data-list="staged"
          :data-path="file.path"
          :data-tooltip="file.path"
          @select="changes.select('staged', file.path)"
          @contextmenu="(event: MouseEvent) => onContextMenu({ list: 'staged', file }, event)"
        />
      </div>
    </div>
    <ContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :label="t('changes.rowMenu')"
      @close="closeMenu"
    >
      <ContextMenuItem
        v-if="menu.list === 'unstaged'"
        :label="t('changes.stage')"
        :icon="Plus"
        :keys="stageHint"
        data-testid="menu-stage"
        @select="menuAction('stage')"
      />
      <ContextMenuItem
        v-else
        :label="t('changes.unstage')"
        :icon="Minus"
        :keys="unstageHint"
        data-testid="menu-unstage"
        @select="menuAction('unstage')"
      />
      <ContextMenuItem
        v-if="menu.list === 'unstaged'"
        :label="t('changes.discard')"
        :icon="Undo2"
        :keys="discardHint"
        destructive
        data-testid="menu-discard"
        @select="menuAction('discard')"
      />
    </ContextMenu>
    <ContextMenu
      v-if="conflictMenu"
      :x="conflictMenu.x"
      :y="conflictMenu.y"
      :label="t('changes.rowMenu')"
      @close="closeConflictMenu"
    >
      <ContextMenuItem
        :label="t('sequencer.markResolved')"
        :icon="Check"
        :keys="resolveHint"
        data-testid="menu-resolve"
        @select="conflictAction('resolve')"
      />
      <ContextMenuItem
        :label="t('palette.commandsById.open-editor')"
        :icon="Code"
        @select="conflictAction('editor')"
      />
      <ContextMenuItem
        :label="t('palette.commandsById.open-terminal')"
        :icon="Terminal"
        @select="conflictAction('terminal')"
      />
    </ContextMenu>
  </section>
</template>
