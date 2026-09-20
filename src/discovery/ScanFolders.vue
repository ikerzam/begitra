<script setup lang="ts">
// The scan folders block of the home screen: the folders with their counts or scan state, add
// and remove, Scan that becomes Stop, the progress line, and the banner of a folder that
// could not be scanned.

import { CircleAlert, Folder, Plus, X } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import IconButton from "@/components/IconButton.vue";
import Progress from "@/components/Progress.vue";
import { errorText } from "@/shell/errorMessage";
import { useIndexStore } from "@/stores/index";

import { useAddScanFolder } from "./useAddScanFolder";
import { useDiscoveryFormat } from "./useDiscoveryFormat";

const { t } = useI18n();
const index = useIndexStore();
const format = useDiscoveryFormat();
const { addScanFolder } = useAddScanFolder();

const scanErrorMessage = computed(() => {
  if (!index.scanError) return "";
  const text = errorText(index.scanError);
  return t("home.scanFailed", { message: t(text.key, text.params) });
});
</script>

<template>
  <section class="flex flex-col px-5 pt-2" data-testid="scan-folders">
    <div class="flex h-control items-center justify-between gap-2">
      <h2 class="text-lg font-medium text-fg">{{ t("home.scanFolders") }}</h2>
      <div class="flex items-center gap-2">
        <Button
          variant="ghost"
          :icon="Plus"
          data-testid="add-folder"
          @click="() => void addScanFolder()"
        >
          {{ t("home.addFolder") }}
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
          v-else
          variant="primary"
          :disabled="index.scanRoots.length === 0"
          data-testid="scan-start"
          @click="index.startScan()"
        >
          {{ t("home.scan") }}
        </Button>
      </div>
    </div>
    <ul class="flex flex-col" data-testid="scan-folder-list">
      <li
        v-for="folder in index.scanRoots"
        :key="folder"
        class="flex h-row-list items-center gap-3 whitespace-nowrap"
        :data-folder="folder"
        data-testid="scan-folder"
      >
        <component
          :is="format.folderFailed(folder) ? CircleAlert : Folder"
          :size="16"
          :stroke-width="1.5"
          aria-hidden="true"
          class="shrink-0"
          :class="format.folderFailed(folder) ? 'text-danger' : 'text-fg-secondary'"
        />
        <span class="truncate font-mono text-mono-sm text-fg-secondary">
          {{ format.displayPath(folder) }}
        </span>
        <span
          class="truncate text-md"
          :class="format.folderFailed(folder) ? 'text-danger' : 'text-fg-muted'"
          data-testid="scan-folder-status"
        >
          {{ format.folderStatus(folder) }}
        </span>
        <IconButton
          class="ml-auto"
          :label="t('home.removeFolderNamed', { path: format.displayPath(folder) })"
          :icon="X"
          data-testid="remove-folder"
          @click="() => void index.removeRoot(folder)"
        />
      </li>
    </ul>
    <div
      v-if="index.isScanning"
      class="flex h-row-list items-center gap-3"
      data-testid="scan-progress"
    >
      <Progress class="scan-progress shrink-0" indeterminate :label="format.progressLine.value" />
      <span class="truncate text-md text-fg-secondary">{{ format.progressLine.value }}</span>
    </div>
    <div
      v-for="folder in index.failedFolders"
      :key="folder"
      class="mt-2 pb-1"
      data-testid="scan-folder-error"
    >
      <ErrorBanner
        :message="t('home.folderMissing', { path: format.displayPath(folder) })"
        :output="index.folderErrors[folder]?.reason"
        :action="t('home.removeFolder')"
        @action="() => void index.removeRoot(folder)"
      />
    </div>
    <div v-if="index.scanError" class="mt-2 pb-1" data-testid="scan-error">
      <ErrorBanner
        :message="scanErrorMessage"
        :output="index.scanError.detail"
        :action="t('home.retry')"
        @action="index.startScan()"
      />
    </div>
  </section>
</template>

<style scoped>
/* The progress bar of the scanning line is 160px wide; not on the scale. */
.scan-progress {
  width: 160px;
}
</style>
