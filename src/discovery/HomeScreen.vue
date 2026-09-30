<script setup lang="ts">
// Home with projects: the header (the counts, "Open
// folder…", "New project…", Scan or Stop, the scan's progress), the banner of each folder
// project whose folder could not be scanned (its details, and "Remove project", which asks
// first), the banner of a scan that failed, then the projects. The empty Home stays in the shell
// as `HomeEmpty`.

import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import ErrorBanner from "@/components/ErrorBanner.vue";
import { errorText } from "@/shell/errorMessage";
import { sameFolder } from "@/shell/format";
import { useIndexStore } from "@/stores/index";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";

import HomeHeader from "./HomeHeader.vue";
import ProjectList from "./ProjectList.vue";
import { useDiscoveryFormat } from "./useDiscoveryFormat";

const emit = defineEmits<{ openFolder: [] }>();

const { t } = useI18n();
const index = useIndexStore();
const projects = useProjectsStore();
const dialogs = useProjectDialogsStore();
const format = useDiscoveryFormat();
const list = ref<{ focus(): void } | null>(null);

/** The folder projects whose folder the last scans could not read, with the reason. */
const failed = computed(() =>
  projects.sorted.flatMap((project) => {
    const folder = project.folder;
    if (folder === null || !format.folderFailed(folder)) return [];
    const reason = Object.entries(index.folderErrors).find(([known]) =>
      sameFolder(known, folder),
    )?.[1].reason;
    return [{ project, folder, reason: reason ?? "" }];
  }),
);

const scanErrorMessage = computed(() => {
  if (!index.scanError) return "";
  const text = errorText(index.scanError);
  return t("home.scanFailed", { message: t(text.key, text.params) });
});

defineExpose({ focus: () => list.value?.focus() });
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col overflow-y-auto" data-testid="home-screen">
    <HomeHeader @open-folder="emit('openFolder')" />
    <div
      v-for="item in failed"
      :key="item.project.id"
      class="px-5 pt-3"
      data-testid="scan-folder-error"
    >
      <ErrorBanner
        :message="t('home.folderMissing', { path: format.displayPath(item.folder) })"
        :output="item.reason"
        :output-label="t('home.showDetails')"
        plain-output
        :action="t('home.removeProject')"
        @action="dialogs.askDelete(item.project.id)"
      />
    </div>
    <div v-if="index.scanError" class="px-5 pt-3" data-testid="scan-error">
      <ErrorBanner
        :message="scanErrorMessage"
        :output="index.scanError.detail"
        :action="t('home.retry')"
        @action="index.startScan()"
      />
    </div>
    <ProjectList ref="list" />
  </section>
</template>
