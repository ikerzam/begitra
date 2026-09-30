<script setup lang="ts">
// The open project's Overview: the toolbar (the branch groups, the bulk actions, a
// run's line), the table of members and the hint. Skeleton rows while the index loads and while
// a folder project's scan walks its folder; the empty state for a project without members, with
// no column header and no actions ("Edit project…", or "Scan again" for a folder project); the
// error banner, its output open, when the index or the projects cannot be read.

import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import EmptyState from "@/components/EmptyState.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import { errorText } from "@/shell/errorMessage";
import { formatShortcut } from "@/shortcuts/platform";
import { shortcutRegistry } from "@/shortcuts/registry";
import { useFolderStore } from "@/stores/folder";
import { useIndexStore } from "@/stores/index";
import { useOverviewStore } from "@/stores/overview";
import { useProjectsStore } from "@/stores/projects";

import OverviewTable from "./OverviewTable.vue";
import OverviewToolbar from "./OverviewToolbar.vue";

const emit = defineEmits<{ edit: [] }>();

const { t } = useI18n();
const folder = useFolderStore();
const index = useIndexStore();
const projects = useProjectsStore();
const overview = useOverviewStore();
const table = ref<{ focusRows(): void } | null>(null);

const isFolder = computed(() => folder.folder !== null);
const loading = computed(() => !index.loaded || !projects.loaded || folder.state === "scanning");
const failure = computed(() => index.loadError ?? projects.loadError);
const problem = computed(() => {
  const current = failure.value;
  if (!current) return null;
  const text = errorText(current);
  return {
    message: t("project.loadFailed", { message: t(text.key, text.params) }),
    output: current.detail ?? current.message,
  };
});
const empty = computed(() => !problem.value && !loading.value && overview.rows.length === 0);
const selectAllKeys = computed(() => formatShortcut("mod+a", shortcutRegistry().platform));
const emptyText = computed(() =>
  isFolder.value
    ? t("project.emptyFolder", { project: folder.project?.name ?? "" })
    : t("project.empty", { project: folder.project?.name ?? "" }),
);

function retry(): void {
  void index.load();
  void projects.load();
}

defineExpose({ focusRows: (): void => table.value?.focusRows() });
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="project-overview">
    <OverviewToolbar :actions="!problem && !empty" />
    <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div v-if="problem" class="px-3 pt-5" data-testid="overview-error">
        <ErrorBanner
          :message="problem.message"
          :output="problem.output"
          open
          plain-output
          :action="t('changes.tryAgain')"
          @action="retry"
        />
      </div>
      <EmptyState
        v-else-if="empty"
        class="overview-empty"
        :message="emptyText"
        data-testid="overview-empty"
      >
        <Button v-if="isFolder" variant="secondary" @click="folder.scanAgain()">
          {{ t("folder.scanAgain") }}
        </Button>
        <Button v-else variant="secondary" @click="emit('edit')">
          {{ t("project.edit") }}
        </Button>
      </EmptyState>
      <template v-else>
        <OverviewTable ref="table" :loading="loading" :rows-known="overview.rowsKnown" />
        <p class="px-3 py-3 text-sm text-fg-muted" data-testid="overview-hint">
          {{ t("project.hint", { selectAll: selectAllKeys }) }}
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* The empty state's sentence sits 128px under the toolbar, not in the middle. */
.overview-empty {
  padding-top: 128px;
}
</style>
