<script setup lang="ts">
// The Discovery section's folders, those of the folder projects: one row per folder with
// its count of repositories or worktrees, the state of its scan (a folder not found as Home
// flags it, the alert and the words in `--danger`) and a remove control, which removes the
// folder's project after the confirmation that names the repositories leaving Begitra; "Add
// folder", which makes the folder's project and scans it; the empty sentence
// once the projects are read, skeleton rows until then, and the banner with "Try again" when
// they cannot be read.

import { CircleAlert, Folder, Plus, X } from "@lucide/vue";
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import IconButton from "@/components/IconButton.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import type { Project } from "@/ipc/schemas";
import { errorText } from "@/shell/errorMessage";
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

const field = ref<HTMLElement | null>(null);

const loadErrorMessage = computed(() => {
  if (!projects.loadError) return "";
  const text = errorText(projects.loadError);
  return t("home.loadFailed", { message: t(text.key, text.params) });
});

/* A removed folder's control goes with its row: the focus it held moves to the remove control
   now in its place, or to "Add folder", rather than drop to the page. */
watch(folderProjects, (next, previous) => {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !field.value?.contains(active)) return;
  const gone = previous.findIndex(
    (project) =>
      active.dataset.project === String(project.id) && !next.some((kept) => kept.id === project.id),
  );
  if (gone < 0) return;
  void nextTick(() => {
    const controls = field.value?.querySelectorAll<HTMLElement>(
      '[data-testid="scan-folder-remove"]',
    );
    const target =
      controls?.[Math.min(gone, controls.length - 1)] ??
      field.value?.querySelector<HTMLElement>('[data-testid="scan-folders-add"]');
    target?.focus();
  });
});
</script>

<template>
  <SettingsField :label="t('settings.discovery.scanFolders')" wide>
    <div ref="field" class="flex flex-col gap-2" data-testid="scan-folders">
      <ErrorBanner
        v-if="projects.loadError"
        :message="loadErrorMessage"
        :output="projects.loadError.detail"
        :action="t('home.retry')"
        data-testid="scan-folders-error"
        @action="() => void projects.load()"
      />
      <div v-else-if="!projects.loaded" aria-busy="true" data-testid="scan-folders-loading">
        <SkeletonRow v-for="k in 2" :key="k" :index="k" height="list" />
      </div>
      <p
        v-else-if="folderProjects.length === 0"
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
          <component
            :is="format.folderFailed(project.folder) ? CircleAlert : Folder"
            :size="16"
            :stroke-width="1.5"
            aria-hidden="true"
            class="shrink-0"
            :class="format.folderFailed(project.folder) ? 'text-danger' : 'text-fg-secondary'"
          />
          <span
            class="truncate font-mono text-mono-sm text-fg-secondary"
            :data-tooltip="project.folder"
          >
            {{ format.displayPath(project.folder) }}
          </span>
          <span class="flex shrink-0 items-center gap-4 text-sm text-fg-muted">
            <span data-testid="scan-folder-count">{{ format.projectCount(project) }}</span>
            <span
              v-if="format.projectScan(project)"
              :class="{ 'text-danger': format.folderFailed(project.folder) }"
              data-testid="scan-folder-scan"
            >
              {{ format.projectScan(project) }}
            </span>
          </span>
          <span class="flex-1" />
          <IconButton
            :label="
              t('settings.discovery.removeFolder', { path: format.displayPath(project.folder) })
            "
            :icon="X"
            :data-project="project.id"
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
