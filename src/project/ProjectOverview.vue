<script setup lang="ts">
// The project view's Overview: the toolbar (the branch groups; the bulk actions and
// a run's line), the table of members (`MemberRow`), git's output under a row that asks for it,
// and the hint. Skeleton rows while the index loads, the empty state for a source without
// members, the error banner when the index or the projects cannot be read. The keys are
// `useOverviewKeys`'s.

import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Checkbox from "@/components/Checkbox.vue";
import EmptyState from "@/components/EmptyState.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import LaneDot from "@/components/LaneDot.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import { errorText } from "@/shell/errorMessage";
import { useExternal } from "@/shell/useExternal";
import { formatShortcut } from "@/shortcuts/platform";
import { shortcutRegistry } from "@/shortcuts/registry";
import { useFolderStore } from "@/stores/folder";
import { useIndexStore } from "@/stores/index";
import { useOverviewStore, type OverviewRow } from "@/stores/overview";
import { useProjectsStore } from "@/stores/projects";

import MemberRow from "./MemberRow.vue";
import { rowStatus } from "./status";
import { useOverviewKeys } from "./useOverviewKeys";

const emit = defineEmits<{ edit: [] }>();

const { t, n } = useI18n();
const folder = useFolderStore();
const index = useIndexStore();
const projects = useProjectsStore();
const overview = useOverviewStore();
const format = useDiscoveryFormat();
const external = useExternal();
const table = ref<HTMLElement | null>(null);
/** The rows whose git output shows under them. */
const outputs = reactive(new Set<string>());

const isProject = computed(() => folder.source?.kind === "project");
const loading = computed(
  () => !index.loaded || (isProject.value && !projects.loaded) || folder.state === "scanning",
);
const failure = computed(() => index.loadError ?? (isProject.value ? projects.loadError : null));
const problem = computed(() => {
  const current = failure.value;
  if (!current) return null;
  const text = errorText(current);
  return {
    message: t("home.loadFailed", { message: t(text.key, text.params) }),
    output: current.detail ?? current.message,
  };
});
const allSelected = computed(
  () => overview.rows.length > 0 && overview.rows.every((row) => overview.selection.has(row.path)),
);
const someSelected = computed(() => overview.selection.size > 0 && !allSelected.value);
const selectAllKeys = computed(() => formatShortcut("mod+a", shortcutRegistry().platform));
const emptyText = computed(() =>
  t("project.empty", {
    project: folder.project?.name ?? format.displayPath(folder.folder ?? ""),
  }),
);

/** Each row's status column, once per change of the rows. */
const statuses = computed(
  () => new Map(overview.rows.map((row) => [row.path, rowStatus(row, undefined, null, t)])),
);

function open(path: string): void {
  void folder.openRepository(path);
}

const keys = useOverviewKeys({ overview, table, open });

function fetched(row: OverviewRow): string {
  if (row.missing) return "";
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

function retry(): void {
  void index.load();
  if (isProject.value) void projects.load();
}

defineExpose({ focusRows: (): void => keys.focus() });
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="project-overview">
    <div
      class="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2"
      data-testid="overview-toolbar"
    >
      <ul
        class="flex min-h-control min-w-0 flex-1 items-center gap-2 overflow-hidden"
        :aria-label="t('project.groups')"
      >
        <li
          v-for="group in overview.groups"
          :key="group.branch"
          class="flex h-control shrink-0 items-center gap-2 rounded-md border border-line px-2 text-md"
          data-testid="branch-group"
        >
          <LaneDot :lane="group.lane" />
          <span class="text-fg">{{ group.branch }}</span>
          <span class="text-fg-muted">
            {{ t("project.groupCount", { n: n(group.count), total: n(overview.rows.length) }) }}
          </span>
        </li>
      </ul>
      <slot name="actions" />
    </div>
    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div v-if="problem" class="p-4" data-testid="overview-error">
        <ErrorBanner
          :message="problem.message"
          :output="problem.output"
          :action="t('changes.tryAgain')"
          @action="retry"
        />
      </div>
      <div
        v-else
        ref="table"
        role="grid"
        :aria-label="t('project.overview')"
        :aria-multiselectable="true"
        class="flex flex-col"
        data-testid="overview-table"
        @keydown="keys.onKeydown"
      >
        <div
          role="row"
          class="member-header grid h-row-list items-center gap-4 border-b border-line px-3 text-sm text-fg-muted"
        >
          <span role="columnheader" class="flex items-center">
            <Checkbox
              :model-value="allSelected"
              :indeterminate="someSelected"
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
          <span role="columnheader" />
        </div>
        <template v-if="loading && overview.rows.length === 0">
          <SkeletonRow v-for="k in 6" :key="k" :index="k" height="list" />
        </template>
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
          <pre
            v-if="outputs.has(row.path) && statuses.get(row.path)?.output"
            class="mx-4 my-1 overflow-x-auto rounded-md border border-line bg-raised p-3 font-mono text-mono-sm text-fg-secondary"
            data-testid="member-output"
            >{{ statuses.get(row.path)?.output }}</pre>
        </template>
      </div>
      <EmptyState
        v-if="!problem && !loading && overview.rows.length === 0"
        class="flex-1"
        :message="emptyText"
        data-testid="overview-empty"
      >
        <Button v-if="isProject" variant="secondary" @click="emit('edit')">
          {{ t("project.edit") }}
        </Button>
        <Button v-else variant="secondary" @click="folder.scanAgain()">
          {{ t("folder.scanAgain") }}
        </Button>
      </EmptyState>
      <p v-else-if="!problem" class="px-4 py-3 text-sm text-fg-muted" data-testid="overview-hint">
        {{ t("project.hint", { selectAll: selectAllKeys }) }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.member-header {
  grid-template-columns: 14px 180px 180px 64px 64px 200px minmax(0, 1fr) 80px 136px;
}
</style>
