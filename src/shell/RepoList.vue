<script setup lang="ts">
// The Repositories section of the sidebar: the open project's repositories and worktrees in its
// order, each worktree under its repository when both are members, filtered by the sidebar; the
// one the project shows is selected, a missing one is flagged, and ↵ or a click shows the focused
// one. At its first or last row the move goes on to the next section (`edge`).

import { FolderGit2, ListTree } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import ListRow from "@/components/ListRow.vue";
import { isListKeydown, rowStep, useListNavigation } from "@/shortcuts/useListNavigation";
import { useProjectsStore } from "@/stores/projects";

import { sameFolder } from "./format";
import type { RepoRow } from "./useSidebarSections";

const props = defineProps<{ rows: RepoRow[] }>();
const emit = defineEmits<{
  /** A move past the first (-1) or the last (1) row, for the next section. */
  edge: [direction: 1 | -1];
}>();

const { t } = useI18n();
const projects = useProjectsStore();
const listbox = ref<HTMLElement | null>(null);

/** The repository the project shows: the open one, or the one opening or failing. */
const currentPath = computed(() => projects.shownPath);
const rowCount = computed(() => props.rows.length);

/* The selection follows the repository the project shows, then the user's moves. */
const selectedPath = ref<string | null>(currentPath.value);
watch(currentPath, (path) => {
  selectedPath.value = path;
});
const selectedRow = computed({
  get: () =>
    props.rows.findIndex(
      (row) => selectedPath.value !== null && sameFolder(row.path, selectedPath.value),
    ),
  set: (position: number) => {
    selectedPath.value = props.rows[position]?.path ?? null;
  },
});
const tabStopRow = computed(() => Math.max(0, selectedRow.value));

const navigation = useListNavigation({
  count: rowCount,
  selected: selectedRow,
  rowElement: (position) => listbox.value?.querySelector(`[data-index="${position}"]`),
});

function onKeydown(event: KeyboardEvent): void {
  if (!isListKeydown(event)) return;
  const step = rowStep(event);
  const index = selectedRow.value;
  if (step !== 0 && (step === 1 ? index === rowCount.value - 1 : index <= 0)) {
    event.preventDefault();
    emit("edge", step);
    return;
  }
  navigation.onKeydown(event);
}

function open(row: RepoRow): void {
  if (row.missing && !projects.isShown(row.path)) return;
  void projects.show(row.path);
}

/** Selects and focuses the first or the last row (the sidebar entering the list); false when empty. */
function selectEdge(edge: "first" | "last"): boolean {
  if (rowCount.value === 0) return false;
  navigation.select(edge === "first" ? 0 : rowCount.value - 1);
  return true;
}

defineExpose({ focus: navigation.focus, selectEdge });
</script>

<template>
  <div
    id="sidebar-repos"
    ref="listbox"
    role="listbox"
    :aria-label="t('sidebar.repositories')"
    data-testid="repo-list"
    @keydown="onKeydown"
  >
    <ListRow
      v-for="(row, position) in props.rows"
      :key="row.path"
      :data-index="position"
      :data-path="row.path"
      :class="{ 'repo-list-nested': row.nested }"
      :name="row.name"
      :icon="row.worktree ? ListTree : FolderGit2"
      :meta="row.missing ? t('sidebar.notFound') : row.branch"
      :missing="row.missing"
      :selected="position === selectedRow"
      :tab-stop="position === tabStopRow"
      @select="
        () => {
          navigation.select(position);
          open(row);
        }
      "
      @activate="open(row)"
    />
  </div>
</template>

<style scoped>
/* A worktree hangs under its repository, indented one step past the row padding. */
.repo-list-nested {
  padding-left: var(--space-6);
}
</style>
