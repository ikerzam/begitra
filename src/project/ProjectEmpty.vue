<script setup lang="ts">
// The graph area of an open project that shows no repository: a folder project whose
// scan walks its folder says so, with the scan's progress, until the first repository found
// shows; a folder that could not be scanned shows the banner with its details and "Remove
// project"; a project without a present repository says so, with "Scan again" for a folder
// project and "Edit project…" for a list project.

import { computed } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import EmptyState from "@/components/EmptyState.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import Progress from "@/components/Progress.vue";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import { sameFolder } from "@/shell/format";
import { useIndexStore } from "@/stores/index";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";

const { t } = useI18n();
const index = useIndexStore();
const projects = useProjectsStore();
const dialogs = useProjectDialogsStore();
const format = useDiscoveryFormat();

const project = computed(() => projects.active);
const folder = computed(() => project.value?.folder ?? null);
const scanning = computed(() => {
  const state = folder.value === null ? undefined : format.folderState(folder.value);
  return state === "queued" || state === "scanning";
});
const failure = computed(() => {
  const current = folder.value;
  if (current === null || scanning.value || !format.folderFailed(current)) return null;
  return (
    Object.entries(index.folderErrors).find(([known]) => sameFolder(known, current))?.[1].reason ??
    ""
  );
});
/** Members it holds, but none that is there. */
const allMissing = computed(() => (project.value?.members.length ?? 0) > 0);
const message = computed(() => {
  const name = project.value?.name ?? "";
  if (scanning.value) {
    return t("project.scanningFolder", { folder: format.displayPath(folder.value ?? "") });
  }
  if (allMissing.value) return t("project.allMissing", { project: name });
  return folder.value === null
    ? t("project.empty", { project: name })
    : t("project.emptyFolder", { project: name });
});

function edit(): void {
  if (project.value) dialogs.edit(project.value.id);
}

function scanAgain(): void {
  if (folder.value !== null) index.startScan([folder.value]);
}
</script>

<template>
  <section
    v-if="project"
    class="flex min-w-0 flex-1 flex-col"
    :aria-busy="scanning"
    data-testid="project-empty"
  >
    <div v-if="failure !== null" class="p-5" data-testid="project-empty-error">
      <ErrorBanner
        :message="t('home.folderMissing', { path: format.displayPath(folder ?? '') })"
        :output="failure"
        :output-label="t('home.showDetails')"
        plain-output
        :action="t('home.removeProject')"
        @action="dialogs.askDelete(project.id)"
      />
    </div>
    <EmptyState v-else class="flex-1" :message="message">
      <Progress
        v-if="scanning"
        class="project-scanning"
        indeterminate
        :label="message"
        data-testid="project-empty-scanning"
      />
      <Button
        v-else-if="folder !== null"
        variant="secondary"
        data-testid="project-empty-scan"
        @click="scanAgain"
      >
        {{ t("folder.scanAgain") }}
      </Button>
      <Button v-else variant="secondary" data-testid="project-empty-edit" @click="edit">
        {{ t("project.edit") }}
      </Button>
    </EmptyState>
  </section>
</template>

<style scoped>
/* The scan's bar under the sentence is 160px wide, as Home's scanning line. */
.project-scanning {
  width: 160px;
}
</style>
