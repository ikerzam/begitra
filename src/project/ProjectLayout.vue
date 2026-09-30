<script setup lang="ts">
// The open project's Overview and Changes, views of the top bar:
// the 40px header (the project's name, its count or its changes line, refresh, and "Edit
// project…" on the Overview) over the view the layout asks for. The views' lifecycle lives
// here: the models and the folder watchers start when the layout mounts and stop when it goes,
// and the members' summaries are read once the rows are known and as members join, so moving
// between the two keeps them; the two views are mounted one at a time, so their keys never
// both listen.

import { Pencil, RefreshCw } from "@lucide/vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import IconButton from "@/components/IconButton.vue";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import FolderLayout from "@/folder/FolderLayout.vue";
import { useBulkStore } from "@/stores/bulk";
import { useFolderStore } from "@/stores/folder";
import { useIndexStore } from "@/stores/index";
import { useOverviewStore } from "@/stores/overview";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";
import { useShellStore } from "@/stores/shell";

import BulkDialog from "./BulkDialog.vue";
import ProjectOverview from "./ProjectOverview.vue";

const { t, n } = useI18n();
const bulk = useBulkStore();
const folder = useFolderStore();
const index = useIndexStore();
const overview = useOverviewStore();
const dialogs = useProjectDialogsStore();
const projects = useProjectsStore();
const shell = useShellStore();
const format = useDiscoveryFormat();
const overviewView = ref<{ focusRows(): void } | null>(null);
const changesView = ref<{ focusLists(): void } | null>(null);

const view = computed(() => projects.view ?? "overview");
const title = computed(() => folder.project?.name ?? projects.active?.name ?? "");
const meta = computed(() => {
  // A list that could not be read has no count to give.
  if (index.loadError || projects.loadError) return "";
  if (view.value === "overview") {
    // While the rows are not known, how many the project's list names.
    if (!overview.rowsKnown) {
      const named = folder.project?.members.length ?? 0;
      return named > 0 ? t("project.readingMeta", { n: n(named) }, named) : "";
    }
    // A bulk run reads its members again as they finish; the count stays.
    const left = bulk.kind === null ? overview.readsLeft : 0;
    if (left > 0) return t("project.readingMeta", { n: n(left) }, left);
    const count = overview.rows.length;
    return t("project.repositories", { n: n(count) }, count);
  }
  const withChanges = folder.sections.length;
  const without = n(folder.repositories.length - withChanges);
  return t("project.changesMeta", { n: n(withChanges), without }, withChanges);
});

function refresh(): void {
  folder.refresh();
  overview.refresh();
}

function edit(): void {
  const project = folder.project;
  if (project) dialogs.edit(project.id);
}

function focus(): void {
  if (view.value === "overview") overviewView.value?.focusRows();
  else changesView.value?.focusLists();
}

defineExpose({ focus });

// A project deleted meanwhile (another window) leaves the view; a list that could not be read
// keeps it, with its error.
watch(
  () => [projects.loaded, projects.loadError, folder.project] as const,
  ([loaded, failed, shown]) => {
    if (loaded && failed === null && shown === null) void shell.setLayoutMode("graph");
  },
);

// Each member's summary is read once the rows are known (a launch into the view, another
// project opened) and when a member joins the project.
watch(
  () =>
    overview.rowsKnown
      ? overview.rows
          .filter((row) => !row.missing)
          .map((row) => row.path)
          .join("\n")
      : null,
  (paths) => {
    if (paths !== null) overview.readNew();
  },
  { immediate: true },
);

onMounted(() => {
  folder.show();
});
onBeforeUnmount(() => {
  overview.stop();
  folder.hide();
});
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="project-view">
    <header
      class="flex h-bar-top shrink-0 items-center gap-5 border-b border-line px-3"
      data-testid="project-header"
    >
      <div class="flex min-w-0 items-baseline gap-2">
        <h1
          class="truncate text-md font-medium text-fg"
          :data-tooltip="folder.folder ? format.displayPath(folder.folder) : undefined"
          data-testid="project-title"
        >
          {{ title }}
        </h1>
        <span v-if="meta" class="shrink-0 text-sm text-fg-muted" data-testid="project-meta">
          {{ meta }}
        </span>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <IconButton
          :label="t('project.refresh')"
          :icon="RefreshCw"
          data-testid="project-refresh"
          @click="refresh"
        />
        <Button
          v-if="view === 'overview'"
          variant="ghost"
          :icon="Pencil"
          data-testid="edit-project"
          @click="edit"
        >
          {{ t("project.edit") }}
        </Button>
      </div>
    </header>
    <ProjectOverview
      v-if="view === 'overview'"
      ref="overviewView"
      :aria-label="t('project.overview')"
      @edit="edit"
    />
    <FolderLayout v-else ref="changesView" :aria-label="t('project.changes')" />
    <BulkDialog v-if="bulk.plan" />
  </div>
</template>
