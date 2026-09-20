<script setup lang="ts">
// The Discovery section's "Scan folders": one row per folder with its counts and a remove
// control, "Add folder", or the empty sentence.

import { Folder, Plus, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import IconButton from "@/components/IconButton.vue";
import { useAddScanFolder } from "@/discovery/useAddScanFolder";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import { useIndexStore } from "@/stores/index";

import SettingsField from "./SettingsField.vue";

const { t } = useI18n();
const index = useIndexStore();
const format = useDiscoveryFormat();
const { addScanFolder } = useAddScanFolder();

/** "8 repositories", "3 worktrees", or both. */
function counts(root: string): string {
  const found = index.folderCounts(root);
  const parts: string[] = [];
  if (found.repositories > 0 || found.worktrees === 0) {
    parts.push(t("home.repositories", { n: found.repositories }, found.repositories));
  }
  if (found.worktrees > 0) parts.push(t("home.worktrees", { n: found.worktrees }, found.worktrees));
  return parts.join(", ");
}
</script>

<template>
  <SettingsField :label="t('settings.discovery.scanFolders')" wide>
    <div class="flex flex-col gap-2" data-testid="scan-folders">
      <p
        v-if="index.scanRoots.length === 0"
        class="pt-1 text-sm text-fg-muted"
        data-testid="scan-folders-empty"
      >
        {{ t("settings.discovery.noFolders") }}
      </p>
      <ul v-else class="flex flex-col" :aria-label="t('settings.discovery.scanFolders')">
        <li
          v-for="root in index.scanRoots"
          :key="root"
          class="flex h-6 items-center gap-3"
          data-testid="scan-folder"
        >
          <Folder :size="16" :stroke-width="1.5" aria-hidden="true" class="text-fg-secondary" />
          <span class="truncate font-mono text-mono-sm text-fg-secondary">
            {{ format.displayPath(root) }}
          </span>
          <span class="text-sm text-fg-muted" data-testid="scan-folder-count">
            {{ counts(root) }}
          </span>
          <span class="flex-1" />
          <IconButton
            :label="t('home.removeFolderNamed', { path: format.displayPath(root) })"
            :icon="X"
            data-testid="scan-folder-remove"
            @click="() => void index.removeRoot(root)"
          />
        </li>
      </ul>
      <div>
        <Button
          variant="secondary"
          :icon="Plus"
          data-testid="scan-folders-add"
          @click="() => void addScanFolder()"
        >
          {{ t("settings.discovery.addFolder") }}
        </Button>
      </div>
    </div>
  </SettingsField>
</template>
