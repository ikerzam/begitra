<script setup lang="ts">
// The home table: Pinned, Recent, one section per scan folder and one for the repositories
// opened on their own, in one listbox with roving focus, the row menu, and the loading,
// scanning, empty and error states of the index.

import { FilePen } from "@lucide/vue";
import { computed, nextTick, ref, useId } from "vue";
import { useI18n } from "vue-i18n";

import EmptyState from "@/components/EmptyState.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import IconButton from "@/components/IconButton.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import { errorText } from "@/shell/errorMessage";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import { useFolderStore } from "@/stores/folder";
import { useIndexStore } from "@/stores/index";
import { useShellStore } from "@/stores/shell";

import RepoRowMenu from "./RepoRowMenu.vue";
import RepoTableHeader from "./RepoTableHeader.vue";
import RepoTableRow from "./RepoTableRow.vue";
import {
  branchLanes,
  sectionScanState,
  skeletonAfter,
  tableSections,
  type TableRow,
  type TableSection,
} from "./sections";
import { useDiscoveryFormat } from "./useDiscoveryFormat";
import { useRepoActions } from "./useRepoActions";

const { t, n } = useI18n();
const index = useIndexStore();
const format = useDiscoveryFormat();
const actions = useRepoActions();
const listbox = ref<HTMLElement | null>(null);

const shell = useShellStore();
const folderView = useFolderStore();

/* The columns' widths (the settings), which the header and every row read. */
const columnStyle = computed(() => {
  const widths = shell.columnWidths.home;
  return {
    "--repo-name-w": `${widths.name}px`,
    "--repo-branch-w": `${widths.branch}px`,
    "--repo-ahead-w": `${widths.ahead}px`,
    "--repo-commit-w": `${widths.commit}px`,
  };
});

const sections = computed(() => tableSections(index));
const labelIds = useId();

/** A section's label: the folder's path for a scan folder, its name otherwise. */
function sectionLabel(section: TableSection): string {
  return section.folder === null
    ? t(`home.sections.${section.kind}`)
    : format.displayPath(section.folder);
}

/** A section's count, "so far" while the scan walks its folder or has yet to. */
function sectionCount(section: TableSection): string {
  const state = sectionScanState(section, index.scan);
  return state === "scanning" || state === "queued"
    ? t("home.soFar", { n: n(section.count) })
    : n(section.count);
}

/* The position of the section the skeleton rows follow (-1: before them all). */
const skeletons = computed(() => skeletonAfter(sections.value, index.loaded, index.scan));
const rows = computed(() => sections.value.flatMap((section) => section.rows));
const lanes = computed(() => branchLanes(rows.value));
const rowCount = computed(() => rows.value.length);

/* The selection follows the entry, so a refresh or a sort keeps it; none until picked. */
const selectedKey = ref<string | null>(null);
const selectedRow = computed({
  get: () => rows.value.findIndex((row) => row.key === selectedKey.value),
  set: (position: number) => {
    selectedKey.value = rows.value[position]?.key ?? null;
  },
});
const tabStopRow = computed(() => Math.max(0, selectedRow.value));

const navigation = useListNavigation({
  count: rowCount,
  selected: selectedRow,
  onActivate: (position) => {
    const row = rows.value[position];
    if (row) void actions.open(row.entry);
  },
  rowElement: (position) => listbox.value?.querySelector(`[data-index="${position}"]`),
});

function position(row: TableRow): number {
  return rows.value.indexOf(row);
}

const loadErrorMessage = computed(() => {
  if (!index.loadError) return "";
  const text = errorText(index.loadError);
  return t("home.loadFailed", { message: t(text.key, text.params) });
});

/* The row menu: opened from the "…", a right click, or the keyboard on the selected row. */
const menu = ref<{ row: TableRow; x: number; y: number } | null>(null);

function openMenu(row: TableRow, x: number, y: number): void {
  navigation.select(position(row));
  menu.value = { row, x, y };
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
  <div class="mt-3 flex min-h-0 flex-col" :style="columnStyle" data-testid="repo-table">
    <RepoTableHeader />
    <div
      ref="listbox"
      role="listbox"
      :aria-label="t('home.listLabel')"
      class="repo-table-rows flex flex-col"
      data-testid="repo-rows"
      @keydown="onKeydown"
    >
      <template v-if="skeletons === -1">
        <SkeletonRow v-for="k in 4" :key="`skeleton-${k}`" :index="k" height="list" />
      </template>
      <!-- Groups of options, each labelled by its header (the ARIA grouped listbox). -->
      <div
        v-for="(section, at) in sections"
        :key="section.id"
        role="group"
        :aria-labelledby="`${labelIds}-${at}`"
        class="flex flex-col"
      >
        <div
          :id="`${labelIds}-${at}`"
          role="presentation"
          class="flex min-w-0 items-center gap-2 border-b border-line px-3 pt-3 pb-1 text-md font-medium text-fg"
          :data-testid="`section-${section.kind}`"
          :data-tooltip="section.folder ?? undefined"
        >
          <span class="truncate" :class="{ 'font-mono text-mono-sm': section.folder !== null }">
            {{ sectionLabel(section) }}
          </span>
          <span
            v-if="section.kind === 'folder' || section.kind === 'other'"
            class="shrink-0 text-sm font-normal text-fg-muted"
          >
            {{ sectionCount(section) }}
          </span>
          <IconButton
            v-if="section.kind === 'folder' && section.folder !== null"
            class="ml-auto"
            :label="t('home.showChanges')"
            :icon="FilePen"
            data-testid="show-folder-changes"
            @click="() => section.folder !== null && void folderView.open(section.folder)"
          />
        </div>
        <RepoTableRow
          v-for="row in section.rows"
          :key="row.key"
          :row="row"
          :index="position(row)"
          :lane="lanes.get(row.entry.summary.currentBranch ?? '') ?? 0"
          :last-commit="format.shortAgo(row.entry.summary.lastCommitAt)"
          :path="format.displayPath(row.entry.path)"
          :selected="position(row) === selectedRow"
          :tab-stop="position(row) === tabStopRow"
          @select="navigation.select(position(row))"
          @activate="() => void actions.open(row.entry)"
          @menu="(x, y) => openMenu(row, x, y)"
        />
        <template v-if="skeletons === at">
          <SkeletonRow v-for="k in 4" :key="`skeleton-${k}`" :index="k" height="list" />
        </template>
      </div>
    </div>

    <div v-if="index.loadError" class="px-5 pt-3" data-testid="index-error">
      <ErrorBanner
        :message="loadErrorMessage"
        :output="index.loadError.detail"
        :action="t('home.retry')"
        @action="() => void index.load()"
      />
    </div>
    <EmptyState
      v-else-if="index.loaded && !index.isScanning && rows.length === 0"
      :message="t('home.noneFound')"
      data-testid="repo-table-empty"
    />

    <RepoRowMenu v-if="menu" :entry="menu.row.entry" :x="menu.x" :y="menu.y" @close="closeMenu" />
  </div>
</template>
