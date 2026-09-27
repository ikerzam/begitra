<script setup lang="ts">
// The project view and the folder view: the header (the project's
// name or the folder's path, its count, the Overview and Changes tabs, refresh, and "Save as
// project" for a folder) over the tab's content. The view's lifecycle lives here: the models and
// the folder watchers start when it mounts and stop when it goes, and the members' summaries are
// read once the rows are known and as members join, so switching tabs keeps them; the two tabs
// are mounted one at a time, so their keys never both listen.

import { Layers, Pencil, RefreshCw } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import IconButton from "@/components/IconButton.vue";
import TabsItem from "@/components/TabsItem.vue";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import FolderLayout from "@/folder/FolderLayout.vue";
import { useBulkStore } from "@/stores/bulk";
import { useFolderStore } from "@/stores/folder";
import { useIndexStore } from "@/stores/index";
import { useOverviewStore } from "@/stores/overview";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";
import { useSettingsStore, type ProjectTab } from "@/stores/settings";
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
const settings = useSettingsStore();
const shell = useShellStore();
const format = useDiscoveryFormat();
const overviewTab = ref<{ focusRows(): void } | null>(null);
const changesTab = ref<{ focusLists(): void } | null>(null);
const tabList = ref<HTMLElement | null>(null);

const tabs: ProjectTab[] = ["overview", "changes"];
const tab = computed(() => settings.values.projectTab);
const isProject = computed(() => folder.source?.kind === "project");
const title = computed(() =>
  isProject.value ? (folder.project?.name ?? "") : format.displayPath(folder.folder ?? ""),
);
const meta = computed(() => {
  // A list that could not be read has no count to give.
  if (index.loadError || (isProject.value && projects.loadError)) return "";
  if (tab.value === "overview") {
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

function select(next: ProjectTab): void {
  if (next !== tab.value) void settings.update("projectTab", next);
}

function onTabKeydown(event: KeyboardEvent): void {
  const at = tabs.indexOf(tab.value);
  let next = at;
  if (event.key === "ArrowRight") next = (at + 1) % tabs.length;
  else if (event.key === "ArrowLeft") next = (at - 1 + tabs.length) % tabs.length;
  else return;
  event.preventDefault();
  const chosen = tabs[next];
  if (!chosen) return;
  select(chosen);
  void nextTick(() => tabList.value?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus());
}

function refresh(): void {
  folder.refresh();
  overview.refresh();
}

/** Makes a project of the folder's repositories and worktrees in path order, on the same tab. */
async function saveAsProject(): Promise<void> {
  const shown = folder.folder;
  if (shown !== null) await projects.saveFolder(shown, tab.value);
}

function edit(): void {
  const project = folder.project;
  if (project) dialogs.edit(project.id);
}

function focus(): void {
  if (tab.value === "overview") overviewTab.value?.focusRows();
  else changesTab.value?.focusLists();
}

defineExpose({ focus });

// A project deleted meanwhile (another window, a stale setting at launch) leaves the view; a
// list that could not be read keeps it, with its error.
watch(
  () => [isProject.value, projects.loaded, projects.loadError, folder.project] as const,
  ([project, loaded, failed, shown]) => {
    if (project && loaded && failed === null && shown === null) void shell.setLayoutMode("graph");
  },
);

// Each member's summary is read once the rows are known (a launch into the view, another
// project shown) and when a member joins the source.
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
          :class="isProject ? '' : 'font-mono text-mono-sm'"
          :data-tooltip="isProject ? undefined : (folder.folder ?? undefined)"
          data-testid="project-title"
        >
          {{ title }}
        </h1>
        <span v-if="meta" class="shrink-0 text-sm text-fg-muted" data-testid="project-meta">
          {{ meta }}
        </span>
      </div>
      <div
        ref="tabList"
        role="tablist"
        :aria-label="t('project.tabs')"
        class="flex items-center gap-4 self-stretch"
        @keydown="onTabKeydown"
      >
        <TabsItem
          v-for="id in tabs"
          :id="`project-tab-${id}`"
          :key="id"
          tall
          :label="t(`project.${id}`)"
          :selected="tab === id"
          :controls="`project-${id}`"
          :data-testid="`project-tab-${id}`"
          @select="select(id)"
        />
      </div>
      <div class="ml-auto flex items-center gap-2">
        <IconButton
          :label="t('project.refresh')"
          :icon="RefreshCw"
          data-testid="project-refresh"
          @click="refresh"
        />
        <Button
          v-if="!isProject"
          variant="ghost"
          :icon="Layers"
          data-testid="save-as-project"
          @click="() => void saveAsProject()"
        >
          {{ t("project.saveAsProject") }}
        </Button>
        <Button v-else variant="ghost" :icon="Pencil" data-testid="edit-project" @click="edit">
          {{ t("project.edit") }}
        </Button>
        <slot name="actions" />
      </div>
    </header>
    <ProjectOverview
      v-if="tab === 'overview'"
      id="project-overview"
      ref="overviewTab"
      role="tabpanel"
      aria-labelledby="project-tab-overview"
      @edit="edit"
    />
    <FolderLayout
      v-else
      id="project-changes"
      ref="changesTab"
      role="tabpanel"
      aria-labelledby="project-tab-changes"
    />
    <BulkDialog v-if="bulk.plan" />
  </div>
</template>
