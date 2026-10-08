<script setup lang="ts">
// The refs of one sidebar section (the local branches, the remote branches or the tags),
// filtered by the panel, with roving focus and j/k navigation. Selecting a branch scopes the graph
// to it (the selection lives in the graph store, so the scope control and the lists agree);
// nothing is selected until the user picks a row, and the first row is the tab stop until then.
// ↵ checks a branch out.

import { Tag } from "@lucide/vue";
import { computed, inject, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import RefMenu from "@/branches/RefMenu.vue";
import type { BranchAction } from "@/branches/useBranchActions";
import ListRow from "@/components/ListRow.vue";
import MotionRows from "@/components/MotionRows.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import type { Ref as GitRef } from "@/ipc/schemas";
import { isListKeydown, useListNavigation } from "@/shortcuts/useListNavigation";
import { useRepoStore } from "@/stores/repo";

import { branchSelectionKey, useBranchSelection } from "./useBranchSelection";
import type { BranchRow } from "./useSidebarSection";

const props = defineProps<{
  rows: BranchRow[];
  /** Which refs: the list's id and the tag icon. */
  kind: "local" | "remote" | "tags";
  /** The accessible name of the list. */
  label: string;
}>();
const emit = defineEmits<{
  action: [kind: BranchAction, ref: GitRef];
}>();

const { t } = useI18n();
const repo = useRepoStore();
const listbox = ref<HTMLElement | null>(null);
const menu = ref<{ ref: GitRef; x: number; y: number } | null>(null);

const rowCount = computed(() => props.rows.length);

/** What an empty list of each kind says. */
const EMPTY = {
  local: "sidebar.noBranches",
  remote: "sidebar.noRemoteBranches",
  tags: "sidebar.noTags",
} as const;

/* The selection is the graph's scope ref, so filtering keeps it; none until the user picks a row.
   The panel provides it and applies a scope still pending when it closes; a list on its own keeps
   its own. */
const shared = inject(branchSelectionKey, null);
const selection = shared ?? useBranchSelection();
if (!shared) onUnmounted(selection.dispose);

const selectedRow = computed({
  get: () => props.rows.findIndex((row) => row.ref.fullName === selection.selectedName.value),
  set: (index: number) => {
    const ref = props.rows[index]?.ref;
    if (ref) selection.select(ref);
  },
});

const tabStopRow = computed(() => Math.max(0, selectedRow.value));

const rowElement = (index: number) => listbox.value?.querySelector(`[data-index="${index}"]`);
const navigation = useListNavigation({
  count: rowCount,
  selected: selectedRow,
  rowElement,
  onActivate: (index) => activate(index),
});

/** ↵ or a double click on a row: checks the branch out (not the current one). */
function activate(index: number): void {
  const ref = props.rows[index]?.ref;
  if (ref && !ref.isCurrent) emit("action", "checkout", ref);
}

/** The menu opens under the row, past the lane dot, where the graph opens its own. */
const MENU_OFFSET_X = 116;

function onKeydown(event: KeyboardEvent): void {
  if (!isListKeydown(event)) return;
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    const ref = props.rows[selectedRow.value]?.ref;
    if (!ref) return;
    event.preventDefault();
    const rect = rowElement(selectedRow.value)?.getBoundingClientRect();
    menu.value = { ref, x: rect ? rect.left + MENU_OFFSET_X : 0, y: rect ? rect.bottom : 0 };
    return;
  }
  navigation.onKeydown(event);
}

function onContextMenu(index: number, event: MouseEvent): void {
  event.preventDefault();
  navigation.select(index);
  const ref = props.rows[index]?.ref;
  if (ref) menu.value = { ref, x: event.clientX, y: event.clientY };
}

/**
 * The menu closed: the row takes the focus back at once. The menu closes before its item acts
 * (see `RefMenu`), so a dialog the action opens returns the focus here; a second close is a
 * no-op.
 */
function closeMenu(): void {
  if (menu.value === null) return;
  menu.value = null;
  navigation.focus();
}

defineExpose({ focus: navigation.focus });
</script>

<template>
  <div
    :id="`sidebar-${props.kind}`"
    ref="listbox"
    role="listbox"
    :aria-label="props.label"
    :data-testid="`branch-list-${props.kind}`"
    @keydown="onKeydown"
  >
    <MotionRows
      list="branches"
      :count="props.rows.length"
      role="none"
      @focus-lost="navigation.focus()"
    >
      <ListRow
        v-for="(row, index) in props.rows"
        :key="row.ref.fullName"
        :data-index="index"
        :name="row.ref.name"
        :lane="row.lane"
        :icon="props.kind === 'tags' ? Tag : undefined"
        :ahead="row.ref.upstream ? (row.ref.ahead ?? undefined) : undefined"
        :behind="row.ref.upstream ? (row.ref.behind ?? undefined) : undefined"
        :selected="index === selectedRow"
        :tab-stop="index === tabStopRow"
        @select="navigation.select(index)"
        @activate="activate(index)"
        @contextmenu="(event: MouseEvent) => onContextMenu(index, event)"
      />
    </MotionRows>
    <template
      v-if="
        props.rows.length === 0 &&
        (repo.state.kind === 'opening' || (repo.state.kind === 'ready' && !repo.refsLoaded))
      "
    >
      <SkeletonRow v-for="n in 6" :key="n" :index="n" height="list" />
    </template>
    <p
      v-else-if="props.rows.length === 0"
      class="px-3 py-2 text-md text-fg-secondary"
      data-testid="branch-list-empty"
    >
      {{ repo.state.kind === "ready" ? t(EMPTY[props.kind]) : t("sidebar.noRepository") }}
    </p>
  </div>
  <RefMenu
    v-if="menu"
    :target="menu.ref"
    :x="menu.x"
    :y="menu.y"
    enter-checks-out
    @close="closeMenu"
  />
</template>
