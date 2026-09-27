<script setup lang="ts">
// The project view and the folder view: the header (the project's
// name or the folder's path, its count, the Overview and Changes tabs, refresh, and "Save as
// project" for a folder) over the tab's content. The view's lifecycle lives here: the models,
// the reads and the folder watchers start when it mounts and stop when it goes, so switching
// tabs keeps them, and the two tabs are mounted one at a time, so their keys never both listen.

import { Layers, RefreshCw } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import IconButton from "@/components/IconButton.vue";
import TabsItem from "@/components/TabsItem.vue";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import FolderLayout from "@/folder/FolderLayout.vue";
import { baseName } from "@/shell/format";
import { useBulkStore } from "@/stores/bulk";
import { useFolderStore } from "@/stores/folder";
import { useOverviewStore } from "@/stores/overview";
import { useProjectsStore } from "@/stores/projects";
import { useSettingsStore, type ProjectTab } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";

import BulkDialog from "./BulkDialog.vue";
import ProjectOverview from "./ProjectOverview.vue";

const { t, n } = useI18n();
const bulk = useBulkStore();
const folder = useFolderStore();
const overview = useOverviewStore();
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
  if (tab.value === "overview") {
    const left = overview.readsLeft;
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
  if (shown === null) return;
  const project = await projects.create(
    baseName(shown),
    folder.listed.map((member) => member.path),
  );
  if (project) await projects.open(project.id, tab.value);
}

function focus(): void {
  if (tab.value === "overview") overviewTab.value?.focusRows();
  else changesTab.value?.focusLists();
}

defineExpose({ focus });

// A project deleted meanwhile (another window, a stale setting at launch) leaves the view.
watch(
  () => [isProject.value, projects.loaded, folder.project] as const,
  ([project, loaded, shown]) => {
    if (project && loaded && shown === null) void shell.setLayoutMode("graph");
  },
);

onMounted(() => {
  folder.show();
  overview.refresh();
});
onBeforeUnmount(() => {
  overview.stop();
  folder.hide();
});
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="project-view">
    <header
      class="flex h-bar-top shrink-0 items-center gap-4 border-b border-line px-4"
      data-testid="project-header"
    >
      <div class="flex min-w-0 items-baseline gap-2">
        <h1
          class="truncate text-lg font-medium text-fg"
          :class="isProject ? '' : 'font-mono text-mono-sm'"
          :data-tooltip="isProject ? undefined : (folder.folder ?? undefined)"
          data-testid="project-title"
        >
          {{ title }}
        </h1>
        <span class="shrink-0 text-sm text-fg-muted" data-testid="project-meta">{{ meta }}</span>
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
        <slot name="actions" />
      </div>
    </header>
    <ProjectOverview
      v-if="tab === 'overview'"
      id="project-overview"
      ref="overviewTab"
      role="tabpanel"
    />
    <FolderLayout v-else id="project-changes" ref="changesTab" role="tabpanel" />
    <BulkDialog v-if="bulk.plan" />
  </div>
</template>
