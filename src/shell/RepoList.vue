<script setup lang="ts">
// The sidebar's Repositories panel: the open project's repositories and worktrees in its order,
// each worktree under its repository when both are members, filtered by the panel; the one the
// project shows is selected, a missing one is flagged, and ↵ or a click shows the focused one and
// says the row was activated (`activated`), which closes the panel.

import { FolderGit2, ListTree } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import ListRow from "@/components/ListRow.vue";
import { isListKeydown, useListNavigation } from "@/shortcuts/useListNavigation";
import { useProjectsStore } from "@/stores/projects";

import { sameFolder } from "./format";
import type { RepoRow } from "./useSidebarSections";

const props = defineProps<{ rows: RepoRow[] }>();
const emit = defineEmits<{
  /** A row was activated (↵ or a click): the panel closes. */
  activated: [];
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
  navigation.onKeydown(event);
}

function open(row: RepoRow): void {
  if (row.missing && !projects.isShown(row.path)) return;
  void projects.show(row.path);
  emit("activated");
}

defineExpose({ focus: navigation.focus });
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
