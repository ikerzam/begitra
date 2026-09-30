<script setup lang="ts">
// The header of Home: the title, the count line, "Open
// folder…", "New project…", and Scan over every folder project, which becomes Stop while a
// scan runs; under it, the scan's progress line.

import { FolderOpen, Plus } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Progress from "@/components/Progress.vue";
import { useIndexStore } from "@/stores/index";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";

import { useDiscoveryFormat } from "./useDiscoveryFormat";

const emit = defineEmits<{ openFolder: [] }>();

const { t } = useI18n();
const index = useIndexStore();
const projects = useProjectsStore();
const dialogs = useProjectDialogsStore();
const format = useDiscoveryFormat();
</script>

<template>
  <header class="flex flex-col px-5 pt-5" data-testid="home-header">
    <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div class="home-title min-w-0">
        <h1 class="text-lg font-semibold text-fg">{{ t("home.title") }}</h1>
        <p class="text-md text-fg-muted" data-testid="home-summary">{{ format.summary.value }}</p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <Button
          variant="secondary"
          :icon="FolderOpen"
          data-testid="home-open-folder"
          @click="emit('openFolder')"
        >
          {{ t("home.openFolder") }}
        </Button>
        <Button
          variant="secondary"
          :icon="Plus"
          data-testid="home-new-project"
          @click="dialogs.create()"
        >
          {{ t("project.new.open") }}
        </Button>
        <Button
          v-if="index.isScanning"
          variant="primary"
          data-testid="scan-stop"
          @click="() => void index.stopScan()"
        >
          {{ t("home.stop") }}
        </Button>
        <Button
          v-else-if="projects.folders.length > 0"
          variant="primary"
          data-testid="scan-start"
          @click="index.startScan()"
        >
          {{ t("home.scan") }}
        </Button>
      </div>
    </div>
    <div
      v-if="index.isScanning"
      class="flex h-row-list items-center gap-3"
      data-testid="scan-progress"
    >
      <Progress class="scan-progress shrink-0" indeterminate :label="format.progressLine.value" />
      <span class="truncate text-md text-fg-secondary">{{ format.progressLine.value }}</span>
    </div>
  </header>
</template>

<style scoped>
/* The progress bar of the scanning line is 160px wide; not on the scale. */
.scan-progress {
  width: 160px;
}
/* The title and its count line keep 280px before the buttons go under them (a narrow window
   at a high zoom). */
.home-title {
  flex: 1 1 280px;
}
</style>
