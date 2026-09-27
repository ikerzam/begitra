<script setup lang="ts">
// The Overview's table: the column header, one `MemberRow` per member with git's
// output under a row that asks for it, and skeleton rows while the rows are not known. One
// roving tab stop; the keys are `useOverviewKeys`'s.

import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";

import Checkbox from "@/components/Checkbox.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import { useExternal } from "@/shell/useExternal";
import { useBulkStore } from "@/stores/bulk";
import { useFolderStore } from "@/stores/folder";
import { useOverviewStore, type OverviewRow } from "@/stores/overview";
import { useProjectsStore } from "@/stores/projects";

import MemberRow from "./MemberRow.vue";
import { rowStatus } from "./status";
import { useOverviewKeys } from "./useOverviewKeys";

const props = defineProps<{ loading: boolean }>();

const { t } = useI18n();
const bulk = useBulkStore();
const folder = useFolderStore();
const projects = useProjectsStore();
const overview = useOverviewStore();
const format = useDiscoveryFormat();
const external = useExternal();
const table = ref<HTMLElement | null>(null);
/** The rows whose git output shows under them. */
const outputs = reactive(new Set<string>());

const isProject = computed(() => folder.source?.kind === "project");
const allSelected = computed(
  () => overview.rows.length > 0 && overview.rows.every((row) => overview.selection.has(row.path)),
);
const someSelected = computed(() => overview.selection.size > 0 && !allSelected.value);

/** Each row's status column, a bulk operation's state first, once per change of the rows. */
const statuses = computed(
  () =>
    new Map(
      overview.rows.map((row) => [
        row.path,
        rowStatus(row, bulk.states.get(row.path), bulk.kind, t),
      ]),
    ),
);

function open(path: string): void {
  void folder.openRepository(path);
}

const keys = useOverviewKeys({
  overview,
  table,
  open,
  // Esc stops a bulk operation before it clears the selection.
  onEscape: () => {
    if (!bulk.running) return false;
    void bulk.stop();
    return true;
  },
});

function fetched(row: OverviewRow): string {
  const run = bulk.states.get(row.path);
  if (run?.state === "done" && run.outcome === "fetched-with") {
    return t("project.fetchedWith", { name: run.with ?? "" });
  }
  return row.fetchedAt === null ? t("project.neverFetched") : format.shortAgo(row.fetchedAt);
}

function toggleOutput(path: string): void {
  if (outputs.has(path)) outputs.delete(path);
  else outputs.add(path);
}

async function remove(path: string): Promise<void> {
  const project = folder.project;
  if (!project) return;
  await projects.setMembers(
    project.id,
    project.members.filter((member) => member !== path),
  );
}

defineExpose({ focusRows: (): void => keys.focus() });
</script>

<template>
  <div
    ref="table"
    role="grid"
    :aria-label="t('project.overview')"
    :aria-multiselectable="true"
    :aria-busy="props.loading"
    class="flex flex-col"
    data-testid="overview-table"
    @keydown="keys.onKeydown"
  >
    <div
      role="row"
      class="member-header grid h-control items-center gap-4 border-b border-l-2 border-line border-l-transparent px-3 text-sm text-fg-muted"
    >
      <span role="columnheader" class="flex items-center">
        <Checkbox
          :model-value="allSelected"
          :indeterminate="someSelected"
          :focusable="false"
          :aria-label="t('project.selectAll')"
          data-testid="overview-select-all"
          @update:model-value="overview.selectAll()"
        />
      </span>
      <span role="columnheader">{{ t("project.columns.repository") }}</span>
      <span role="columnheader">{{ t("project.columns.branch") }}</span>
      <span role="columnheader">{{ t("project.columns.ahead") }}</span>
      <span role="columnheader">{{ t("project.columns.changes") }}</span>
      <span role="columnheader">{{ t("project.columns.status") }}</span>
      <span role="columnheader">{{ t("project.columns.lastCommit") }}</span>
      <span role="columnheader">{{ t("project.columns.fetched") }}</span>
      <span role="columnheader" class="sr-only">{{ t("project.columns.actions") }}</span>
    </div>
    <div v-if="props.loading && overview.rows.length === 0" role="row" aria-hidden="true">
      <SkeletonRow v-for="k in 6" :key="k" :index="k" height="list" />
    </div>
    <template v-for="(row, at) in overview.rows" :key="row.path">
      <MemberRow
        :row="row"
        :lane="overview.lanes.get(row.branch ?? '') ?? 0"
        :selected="overview.selection.has(row.path)"
        :focused="overview.focused === at"
        :tab-stop="overview.focused === at || (overview.focused < 0 && at === 0)"
        :status="statuses.get(row.path) ?? null"
        :fetched="fetched(row)"
        :committed="format.shortAgo(row.lastCommitAt)"
        :output-open="outputs.has(row.path)"
        :removable="isProject"
        @focus="overview.focused = at"
        @toggle="overview.toggle(row.path)"
        @open="open(row.path)"
        @terminal="() => void external.openTerminal(row.path)"
        @editor="() => void external.openEditor(row.path)"
        @remove="() => void remove(row.path)"
        @output="toggleOutput(row.path)"
      />
      <div v-if="outputs.has(row.path) && statuses.get(row.path)?.output" role="row">
        <pre
          role="gridcell"
          class="member-output overflow-x-auto rounded-md border border-line bg-raised p-3 font-mono text-mono-sm text-fg-secondary"
          data-testid="member-output"
          >{{ statuses.get(row.path)?.output }}</pre>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* The columns of `MemberRow`, so the labels sit over the cells. */
.member-header {
  grid-template-columns: 14px 180px 180px 64px 64px 200px minmax(0, 1fr) 80px 52px;
}
/* Under its row from the name column to 12px before the edge, 4px above and 8px below
   */
.member-output {
  margin: 4px 12px 8px 44px;
}
</style>
