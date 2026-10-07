<script setup lang="ts">
// The sidebar's Worktrees panel: the worktrees of the open repository as their folder name with
// the branch's lane dot and the tree icon, filtered by the panel, with roving focus and j/k
// navigation. Selecting a row selects it in the dashboard; ↵ opens it as the context and says the
// row was activated (`activated`), which closes the panel; a right click or the menu key opens the
// dashboard's row menu without its dialog actions. The rail reads the list; skeleton rows stand in
// until it answers, and a listing that fails says so above the rows.

import { ListTree } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import ErrorBanner from "@/components/ErrorBanner.vue";
import ListRow from "@/components/ListRow.vue";
import MotionRows from "@/components/MotionRows.vue";
import { refocusAfterMenu } from "@/components/menuFocus";
import SkeletonRow from "@/components/SkeletonRow.vue";
import { isListKeydown, useListNavigation } from "@/shortcuts/useListNavigation";
import { useRepoStore } from "@/stores/repo";
import { useWorktreesStore } from "@/stores/worktrees";
import WorktreeContextMenu from "@/worktrees/WorktreeContextMenu.vue";

import { errorText } from "./errorMessage";
import { useExternal } from "./useExternal";
import type { WorktreeRow } from "./useSidebarSection";

const props = defineProps<{ rows: WorktreeRow[] }>();
const emit = defineEmits<{
  /** A row was activated (↵): the panel closes. */
  activated: [];
}>();

const { t } = useI18n();
const repo = useRepoStore();
const worktrees = useWorktreesStore();
const external = useExternal();
const listbox = ref<HTMLElement | null>(null);
const menu = ref<{ path: string; x: number; y: number } | null>(null);
const menuRow = computed(() => worktrees.rows.find((row) => row.path === menu.value?.path) ?? null);

const rowCount = computed(() => props.rows.length);

/* The selection is the dashboard's, so both sides agree; filtering keeps it. */
const selectedRow = computed({
  get: () => props.rows.findIndex((row) => row.key === worktrees.selectedPath),
  set: (index: number) => {
    worktrees.select(props.rows[index]?.key ?? null);
  },
});
const tabStopRow = computed(() => Math.max(0, selectedRow.value));

const navigation = useListNavigation({
  count: rowCount,
  selected: selectedRow,
  onActivate: (index) => {
    const row = props.rows[index];
    if (row) openAsContext(row.key);
  },
  rowElement: (index) => listbox.value?.querySelector(`[data-index="${index}"]`),
});

/** Opens a worktree as the context; the panel closes on it. */
function openAsContext(key: string): void {
  void worktrees.openAsContext(key);
  emit("activated");
}

/** The repository is opening, or open with its worktrees not listed yet. */
const loading = computed(
  () => repo.state.kind === "opening" || (repo.state.kind === "ready" && !repo.worktreesLoaded),
);
const failure = computed(() => {
  const error = repo.state.kind === "ready" ? repo.worktreesError : null;
  if (!error) return null;
  const text = errorText(error);
  return {
    message: t("sidebar.worktreesFailed", { message: t(text.key, text.params) }),
    output: error.detail ?? "",
  };
});

function openMenu(index: number, x: number, y: number): void {
  const row = props.rows[index];
  if (!row) return;
  navigation.select(index);
  menu.value = { path: row.key, x, y };
}

function onContextMenu(index: number, event: MouseEvent): void {
  event.preventDefault();
  openMenu(index, event.clientX, event.clientY);
}

/** The menu key (or Shift+F10) opens the selected row's menu under it; the rest moves. */
function onKeydown(event: KeyboardEvent): void {
  // The row menu sits inside the list: its keys stay its own.
  if (!isListKeydown(event)) return;
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    event.preventDefault();
    const index = Math.max(0, selectedRow.value);
    const rect = listbox.value?.querySelector(`[data-index="${index}"]`)?.getBoundingClientRect();
    openMenu(index, rect?.left ?? 0, rect?.bottom ?? 0);
    return;
  }
  navigation.onKeydown(event);
}

/** The menu closed: the list takes the focus back unless an action moved it. */
function closeMenu(): void {
  menu.value = null;
  refocusAfterMenu(() => navigation.focus());
}

/** Runs a menu action on the menu's worktree and closes the menu. */
function withMenuRow(action: (path: string) => void): void {
  const path = menu.value?.path;
  menu.value = null;
  if (path) action(path);
}

defineExpose({ focus: navigation.focus });
</script>

<template>
  <div v-if="failure" class="p-2" data-testid="worktrees-error">
    <ErrorBanner :message="failure.message" :output="failure.output" />
  </div>
  <div
    id="sidebar-worktrees"
    ref="listbox"
    role="listbox"
    :aria-label="t('sidebar.worktrees')"
    data-testid="worktree-list"
    @keydown="onKeydown"
  >
    <MotionRows
      list="worktrees"
      :count="props.rows.length"
      role="none"
      @focus-lost="navigation.focus()"
    >
      <ListRow
        v-for="(row, index) in props.rows"
        :key="row.key"
        :data-index="index"
        :name="row.name"
        :lane="row.lane"
        :icon="ListTree"
        icon-beside
        :missing="row.missing"
        :meta="row.missing ? t('sidebar.notFound') : ''"
        :selected="index === selectedRow"
        :tab-stop="index === tabStopRow"
        @select="navigation.select(index)"
        @activate="openAsContext(row.key)"
        @contextmenu="(event: MouseEvent) => onContextMenu(index, event)"
      />
    </MotionRows>
    <template v-if="props.rows.length === 0 && loading">
      <SkeletonRow v-for="n in 2" :key="n" :index="n" height="list" />
    </template>
    <p v-else-if="props.rows.length === 0 && !failure" class="px-3 py-2 text-md text-fg-secondary">
      {{ repo.state.kind === "ready" ? t("sidebar.noWorktrees") : t("sidebar.noRepository") }}
    </p>
    <WorktreeContextMenu
      v-if="menu && menuRow"
      :row="menuRow"
      :x="menu.x"
      :y="menu.y"
      :dialogs="false"
      @compare="withMenuRow((path) => worktrees.compareWithMain(path))"
      @open-terminal="withMenuRow((path) => void external.openTerminal(path))"
      @open-editor="withMenuRow((path) => void external.openEditor(path))"
      @close="closeMenu"
    />
  </div>
</template>
