<script setup lang="ts">
// The two lists of the changes screen: Unstaged with "Stage all" and
// "Discard all…" in its header, Staged with "Unstage all", flat rows with the status letter
// (the "?" of an untracked file), the path and the stats. For the keyboard the two lists are
// one: j/k and the arrows move through both, Enter opens the row's menu, s, u and Backspace
// act on the selected row (the layout binds them), and the selected row is the tab stop.
// Skeleton rows while the diffs stream, the empty sentence on a clean tree.

import { Minus, Plus, Undo2 } from "@lucide/vue";
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
import type { FileChange } from "@/ipc/schemas";
import { errorText } from "@/shell/errorMessage";
import { useShortcutHint } from "@/shortcuts/useShortcut";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import { useChangesStore, type ChangeList } from "@/stores/changes";

const emit = defineEmits<{
  /** "Discard…" on rows, or "Discard all…": the layout confirms. */
  discard: [files: FileChange[]];
}>();

const { t } = useI18n();
const changes = useChangesStore();
const panel = ref<HTMLElement | null>(null);
const menu = ref<{ list: ChangeList; file: FileChange; x: number; y: number } | null>(null);
/** Whether the focus was last seen inside the panel (a row that leaves the DOM takes it). */
let focusInside = false;
const stageHint = useShortcutHint("stage-file");
const unstageHint = useShortcutHint("unstage-file");
const discardHint = useShortcutHint("discard-file");

interface Row {
  list: ChangeList;
  file: FileChange;
}

/** Both lists as one sequence, for the keyboard. */
const rows = computed<Row[]>(() => [
  ...changes.unstaged.files.map((file) => ({ list: "unstaged" as const, file })),
  ...changes.staged.files.map((file) => ({ list: "staged" as const, file })),
]);
const count = computed(() => rows.value.length);
const selectedIndex = computed({
  get: () => {
    const current = changes.selected;
    if (!current) return -1;
    return rows.value.findIndex(
      (row) => row.list === current.list && row.file.path === current.path,
    );
  },
  set: (index: number) => {
    const row = rows.value[index];
    if (row) changes.select(row.list, row.file.path);
  },
});
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
  changes.select(row.list, row.file.path);
  menu.value = { ...row, x, y };
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
    if (!focusInside || menu.value) return;
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
          :selected="changes.selected?.list === 'unstaged' && changes.selected.path === file.path"
          :tab-stop="tabStop === index"
          :aria-disabled="changes.busy !== null || undefined"
          data-list="unstaged"
          :data-path="file.path"
          :title="file.path"
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
          :selected="changes.selected?.list === 'staged' && changes.selected.path === file.path"
          :tab-stop="tabStop === changes.unstagedCount + index"
          :aria-disabled="changes.busy !== null || undefined"
          data-list="staged"
          :data-path="file.path"
          :title="file.path"
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
  </section>
</template>
