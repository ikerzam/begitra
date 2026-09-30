<script setup lang="ts">
// Home's projects: Pinned, Recent and Projects (every project by name) in one
// listbox with roving focus, a project listed again in Projects when it is pinned or recent;
// ↵, a double click or ↵ on the focused row opens it; its menu opens from the "…", a right
// click, or the menu key and Shift F10 on the focused row. Skeleton rows while the list loads,
// the banner with "Try again" when it cannot be read.

import { computed, nextTick, ref, useId } from "vue";
import { useI18n } from "vue-i18n";

import ErrorBanner from "@/components/ErrorBanner.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import type { Project } from "@/ipc/schemas";
import { errorText } from "@/shell/errorMessage";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import { useProjectsStore } from "@/stores/projects";

import ProjectRow from "./ProjectRow.vue";
import ProjectRowMenu from "./ProjectRowMenu.vue";
import { useAttention } from "./useAttention";
import { useDiscoveryFormat } from "./useDiscoveryFormat";

const { t, n } = useI18n();
const projects = useProjectsStore();
const format = useDiscoveryFormat();
const attention = useAttention();
const listbox = ref<HTMLElement | null>(null);
const labelIds = useId();

type SectionId = "pinned" | "recent" | "projects";

interface ListRow {
  key: string;
  project: Project;
}

const sections = computed(() =>
  (
    [
      { id: "pinned", projects: projects.pinned },
      { id: "recent", projects: projects.recent },
      { id: "projects", projects: projects.sorted },
    ] as { id: SectionId; projects: Project[] }[]
  )
    .map((section) => ({
      id: section.id,
      rows: section.projects.map((project) => ({ key: `${section.id}:${project.id}`, project })),
    }))
    .filter((section) => section.rows.length > 0),
);
const rows = computed<ListRow[]>(() => sections.value.flatMap((section) => section.rows));
const rowCount = computed(() => rows.value.length);

/* The selection follows the row, so a refresh keeps it; none until one is picked. */
const selectedKey = ref<string | null>(null);
const selectedRow = computed({
  get: () => rows.value.findIndex((row) => row.key === selectedKey.value),
  set: (position: number) => {
    selectedKey.value = rows.value[position]?.key ?? null;
  },
});
const tabStopRow = computed(() => Math.max(0, selectedRow.value));

function open(project: Project): void {
  void projects.open(project.id);
}

const navigation = useListNavigation({
  count: rowCount,
  selected: selectedRow,
  onActivate: (position) => {
    const row = rows.value[position];
    if (row) open(row.project);
  },
  rowElement: (position) => listbox.value?.querySelector(`[data-index="${position}"]`),
});

function position(row: ListRow): number {
  return rows.value.indexOf(row);
}

const loadErrorMessage = computed(() => {
  if (!projects.loadError) return "";
  const text = errorText(projects.loadError);
  return t("home.loadFailed", { message: t(text.key, text.params) });
});

/* The row menu: opened from the "…", a right click, or the keyboard on the selected row. */
const menu = ref<{ project: Project; x: number; y: number } | null>(null);

function openMenu(row: ListRow, x: number, y: number): void {
  navigation.select(position(row));
  menu.value = { project: row.project, x, y };
}

function closeMenu(): void {
  menu.value = null;
  void nextTick(() => navigation.focus());
}

function onKeydown(event: KeyboardEvent): void {
  const wantsMenu = event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
  if (wantsMenu && selectedRow.value >= 0) {
    event.preventDefault();
    const row = rows.value[selectedRow.value];
    const element = listbox.value?.querySelector(`[data-index="${selectedRow.value}"]`);
    const rect = element?.getBoundingClientRect();
    if (row) openMenu(row, rect ? rect.left + 24 : 0, rect ? rect.bottom : 0);
    return;
  }
  navigation.onKeydown(event);
}

defineExpose({ focus: navigation.focus });
</script>

<template>
  <div class="mt-3 flex min-h-0 flex-col" data-testid="project-list">
    <div
      ref="listbox"
      role="listbox"
      :aria-label="t('home.listLabel')"
      :aria-busy="!projects.loaded"
      class="flex flex-col"
      data-testid="project-rows"
      @keydown="onKeydown"
    >
      <template v-if="!projects.loaded">
        <SkeletonRow v-for="k in 4" :key="`skeleton-${k}`" :index="k" height="list" />
      </template>
      <!-- Groups of options, each labelled by its header (the ARIA grouped listbox). -->
      <div
        v-for="(section, at) in sections"
        :key="section.id"
        role="group"
        :aria-labelledby="`${labelIds}-${at}`"
        class="flex flex-col"
        :data-testid="`home-section-${section.id}`"
      >
        <div
          role="presentation"
          class="flex min-w-0 items-center gap-2 border-b border-line px-3 pt-3 pb-1 text-md font-medium text-fg"
        >
          <span :id="`${labelIds}-${at}`" class="truncate">
            {{ t(`home.sections.${section.id}`) }}
          </span>
          <span class="shrink-0 text-sm font-normal text-fg-muted">
            {{ n(section.rows.length) }}
          </span>
        </div>
        <ProjectRow
          v-for="row in section.rows"
          :key="row.key"
          :project="row.project"
          :folder="row.project.folder === null ? '' : format.displayPath(row.project.folder)"
          :status="format.projectStatus(row.project)"
          :failed="row.project.folder !== null && format.folderFailed(row.project.folder)"
          :attention="attention(row.project)"
          :index="position(row)"
          :selected="position(row) === selectedRow"
          :tab-stop="position(row) === tabStopRow"
          @select="navigation.select(position(row))"
          @activate="open(row.project)"
          @menu="(x, y) => openMenu(row, x, y)"
        />
      </div>
    </div>
    <div v-if="projects.loadError" class="px-5 pt-3" data-testid="projects-error">
      <ErrorBanner
        :message="loadErrorMessage"
        :output="projects.loadError.detail"
        :action="t('home.retry')"
        @action="() => void projects.load()"
      />
    </div>
    <ProjectRowMenu
      v-if="menu"
      :project="menu.project"
      :x="menu.x"
      :y="menu.y"
      @close="closeMenu"
    />
  </div>
</template>
