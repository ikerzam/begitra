<script setup lang="ts">
// The home table: the Pinned, Recent and All sections in one listbox with roving focus, the
// row menu, and the loading, scanning, empty and error states of the index.

import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";

import EmptyState from "@/components/EmptyState.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import { errorText } from "@/shell/errorMessage";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import { useIndexStore } from "@/stores/index";

import RepoRowMenu from "./RepoRowMenu.vue";
import RepoTableHeader from "./RepoTableHeader.vue";
import RepoTableRow from "./RepoTableRow.vue";
import { branchLanes, tableSections, type TableRow } from "./sections";
import { useDiscoveryFormat } from "./useDiscoveryFormat";
import { useRepoActions } from "./useRepoActions";

const { t } = useI18n();
const index = useIndexStore();
const format = useDiscoveryFormat();
const actions = useRepoActions();
const listbox = ref<HTMLElement | null>(null);

const sections = computed(() => tableSections(index));
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
  <div class="mt-3 flex min-h-0 flex-col" data-testid="repo-table">
    <RepoTableHeader />
    <div
      ref="listbox"
      role="listbox"
      :aria-label="t('home.listLabel')"
      class="repo-table-rows flex flex-col"
      data-testid="repo-rows"
      @keydown="onKeydown"
    >
      <template v-for="section in sections" :key="section.id">
        <p
          class="flex items-center gap-2 border-b border-line px-3 pt-3 pb-1 text-md font-medium text-fg"
          :data-testid="`section-${section.id}`"
        >
          {{ t(`home.sections.${section.id}`) }}
          <span v-if="section.id === 'all'" class="text-sm font-normal text-fg-muted">
            {{ index.isScanning ? t("home.soFar", { n: section.count }) : section.count }}
          </span>
        </p>
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
      </template>
      <template v-if="index.isScanning || !index.loaded">
        <SkeletonRow v-for="n in 4" :key="`skeleton-${n}`" :index="n" height="list" />
      </template>
    </div>

    <div v-if="index.loadError" class="px-3 pt-3" data-testid="index-error">
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

<style scoped>
/* Column widths: name 200, branch 180, ahead/behind 84, last
   commit 80, then the path, with the row's 16px gap (columns start at 60/276/472/572/668). */
.repo-table-rows {
  --repo-name-w: 200px;
  --repo-branch-w: 180px;
  --repo-ahead-w: 84px;
  --repo-commit-w: 80px;
}
</style>
