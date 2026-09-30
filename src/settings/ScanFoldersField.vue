<script setup lang="ts">
// The Discovery section's folders, those of the folder projects: one row per folder with
// its count of repositories or worktrees and a remove control, which removes the folder's
// project after the confirmation that names the repositories leaving Begitra; "Add folder",
// which makes the folder's project and scans it; or the empty sentence.

import { Folder, Plus, X } from "@lucide/vue";
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import IconButton from "@/components/IconButton.vue";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import type { Project } from "@/ipc/schemas";
import { useOpenFolder } from "@/shell/useOpenFolder";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";

import SettingsField from "./SettingsField.vue";

const { t } = useI18n();
const projects = useProjectsStore();
const dialogs = useProjectDialogsStore();
const format = useDiscoveryFormat();
const { addFolder } = useOpenFolder();

/** The folder projects, by name. */
const folderProjects = computed(() =>
  projects.sorted.filter((project): project is Project & { folder: string } =>
    Boolean(project.folder),
  ),
);
</script>

<template>
  <SettingsField :label="t('settings.discovery.scanFolders')" wide>
    <div class="flex flex-col gap-2" data-testid="scan-folders">
      <p
        v-if="projects.folders.length === 0"
        class="pt-1 text-sm text-fg-muted"
        data-testid="scan-folders-empty"
      >
        {{ t("settings.discovery.noFolders") }}
      </p>
      <ul v-else class="flex flex-col" :aria-label="t('settings.discovery.scanFolders')">
        <li
          v-for="project in folderProjects"
          :key="project.id"
          class="flex h-6 items-center gap-3"
          data-testid="scan-folder"
        >
          <Folder :size="16" :stroke-width="1.5" aria-hidden="true" class="text-fg-secondary" />
          <span class="truncate font-mono text-mono-sm text-fg-secondary">
            {{ format.displayPath(project.folder) }}
          </span>
          <span class="text-sm text-fg-muted" data-testid="scan-folder-count">
            {{ format.projectStatus(project) }}
          </span>
          <span class="flex-1" />
          <IconButton
            :label="
              t('settings.discovery.removeFolder', { path: format.displayPath(project.folder) })
            "
            :icon="X"
            data-testid="scan-folder-remove"
            @click="dialogs.askDelete(project.id)"
          />
        </li>
      </ul>
      <div>
        <Button
          variant="secondary"
          :icon="Plus"
          data-testid="scan-folders-add"
          @click="() => void addFolder()"
        >
          {{ t("settings.discovery.addFolder") }}
        </Button>
      </div>
    </div>
  </SettingsField>
</template>
