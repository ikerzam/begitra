<script setup lang="ts">
// The folder view, the Changes of a project of several repositories: the list panel (the scan's
// line while it walks, a section per repository with changes, the group of the others, and the
// commit box of the repository the selection is in), the divider of the changes screen, and the
// viewer of the selected file; without repositories, "Scan again" for a folder project and "Edit
// project…" for a list project. The header, the refresh and the view's lifecycle are
// `ProjectLayout`'s. The keys are `useFolderKeys`'s; a discard confirms once and names the
// repository.

import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import ChangesScope from "@/changes/ChangesScope.vue";
import ChangesViewer from "@/changes/ChangesViewer.vue";
import CommitBox from "@/changes/CommitBox.vue";
import { useDiscardDialog } from "@/changes/useDiscardDialog";
import Button from "@/components/Button.vue";
import Dialog from "@/components/Dialog.vue";
import EmptyState from "@/components/EmptyState.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import { errorText } from "@/shell/errorMessage";
import PaneResizer from "@/shell/PaneResizer.vue";
import { useFolderStore } from "@/stores/folder";
import { useIndexStore } from "@/stores/index";
import { useOverviewStore } from "@/stores/overview";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { paneLimits, useShellStore } from "@/stores/shell";

import FolderGroup from "./FolderGroup.vue";
import FolderSection from "./FolderSection.vue";
import { useFolderKeys } from "./useFolderKeys";

const { t, n } = useI18n();
const folder = useFolderStore();
const index = useIndexStore();
const overview = useOverviewStore();
const dialogs = useProjectDialogsStore();
const shell = useShellStore();
const format = useDiscoveryFormat();
const discard = useDiscardDialog();
const viewer = ref<{ actOnSelection(action: "stage" | "unstage" | "discard"): boolean } | null>(
  null,
);
const keys = useFolderKeys({ folder, discard, viewer });
const listsWidth = computed(() => `${shell.paneSizes.files}px`);
/** Where the view looks, for its scan's lines: a folder project's folder, a list project's
 * name. */
const shownFolder = computed(() =>
  folder.folder !== null ? format.displayPath(folder.folder) : (folder.project?.name ?? ""),
);
const reading = computed(() => folder.state === "scanning" || folder.state === "loading");

/** The branch the box names, "detached HEAD" when detached. */
const activeBranch = computed(() => {
  const active = folder.active;
  if (!active) return "";
  return active.detached ? t("statusBar.detached") : (active.branch ?? "");
});

/** The lane of the box's branch among the Overview's groups; 0 for none (detached, unread). */
const activeLane = computed(() => {
  const active = folder.active;
  if (!active || active.detached || !active.branch) return 0;
  return overview.lanes.get(active.branch) ?? 0;
});

/** The banner of an index that did not load or a scan of the folder that failed. */
const problem = computed(() => {
  const current = folder.problem;
  if (!current) return null;
  if (current.kind === "index") {
    const text = errorText(current.error);
    return {
      message: t("home.loadFailed", { message: t(text.key, text.params) }),
      output: current.error.detail ?? current.error.message,
      action: t("changes.tryAgain"),
    };
  }
  return {
    message: t("folder.scanFailed", { folder: shownFolder.value }),
    output: current.reason,
    action: t("folder.scanAgain"),
  };
});

function retry(): void {
  if (folder.problem?.kind === "index") void index.load();
  else folder.scanAgain();
}

defineExpose({ focusLists: (): void => keys.focusActive() });

// Entered while the first reads ran: the first section takes the focus once it shows, unless
// the user put it somewhere meanwhile.
watch(
  () => folder.active?.root ?? null,
  (now, before) => {
    const idle = document.activeElement === null || document.activeElement === document.body;
    if (before === null && now !== null && idle) void nextTick(() => keys.focusActive());
  },
);
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1" data-testid="folder-view">
    <div
      class="flex shrink-0 flex-col border-r border-line"
      :style="{ width: listsWidth }"
      data-testid="folder-panel"
    >
      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="folder-sections">
        <p
          v-if="reading || folder.scanning"
          class="px-3 pt-2 pb-1 text-sm text-fg-muted"
          data-testid="folder-loading"
        >
          {{
            folder.state === "loading"
              ? t("folder.readingLine", { n: n(folder.checking.length) }, folder.checking.length)
              : t("folder.looking", { folder: shownFolder })
          }}
        </p>
        <template v-if="reading">
          <SkeletonRow v-for="k in 4" :key="k" :index="k" height="tree" />
        </template>
        <div v-if="folder.state === 'error' && problem" class="p-3" data-testid="folder-error">
          <ErrorBanner
            :message="problem.message"
            :output="problem.output"
            :action="problem.action"
            @action="retry"
          />
        </div>
        <EmptyState
          v-else-if="folder.state === 'empty'"
          class="flex-1"
          :message="t('folder.empty', { project: folder.project?.name ?? '' })"
          data-testid="folder-empty"
        >
          <Button
            v-if="folder.folder !== null"
            variant="secondary"
            data-testid="folder-scan-again"
            @click="folder.scanAgain()"
          >
            {{ t("folder.scanAgain") }}
          </Button>
          <Button
            v-else-if="folder.project"
            variant="secondary"
            data-testid="folder-edit-project"
            @click="dialogs.edit(folder.project.id)"
          >
            {{ t("project.edit") }}
          </Button>
        </EmptyState>
        <EmptyState
          v-else-if="folder.state === 'clean'"
          class="flex-1"
          :message="t('folder.allClean', { n: n(folder.clean.length) }, folder.clean.length)"
          data-testid="folder-clean"
        />
        <FolderSection
          v-for="section in folder.sections"
          :key="section.root"
          :ref="(handle) => keys.setSection(section.root, handle)"
          :repository="section"
          :collapsed="folder.collapsed.has(section.root)"
          :active="folder.active?.root === section.root"
          @toggle="folder.toggleSection(section.root)"
          @open="() => void folder.openRepository(section.root)"
          @activate="folder.activate(section.root)"
          @discard="(files) => discard.ask(section.view, { kind: 'files', files }, section.name)"
          @edge="(direction) => keys.enterNext(section.root, direction)"
        />
        <FolderGroup v-if="folder.state !== 'loading'" />
      </div>
      <ChangesScope v-if="folder.active" :key="folder.active.root" :view="folder.active.view">
        <CommitBox
          :target-name="folder.active.name"
          :target-branch="activeBranch"
          :target-lane="activeLane"
          @push-left="keys.focusActive()"
        />
      </ChangesScope>
    </div>
    <PaneResizer
      :size="shell.paneSizes.files"
      :min="paneLimits.files.min"
      :max="paneLimits.files.max"
      :label="t('folder.title')"
      @resize="(px) => void shell.setPaneSize('files', px)"
      @reset="() => void shell.resetPaneSize('files')"
    />
    <ChangesScope v-if="folder.active" :key="folder.active.root" :view="folder.active.view">
      <ChangesViewer
        ref="viewer"
        @discard="
          (request) => folder.active && discard.ask(folder.active.view, request, folder.active.name)
        "
      />
    </ChangesScope>
    <div
      v-else-if="reading"
      class="flex min-w-0 flex-1 flex-col py-1"
      data-testid="folder-viewer-loading"
    >
      <SkeletonRow v-for="k in 24" :key="k" :index="k" height="diff" />
    </div>
    <EmptyState
      v-else-if="folder.state === 'clean'"
      class="flex-1"
      :message="t('folder.allCleanDetail', { project: folder.project?.name ?? '' })"
    />
    <div v-else class="min-w-0 flex-1" />
    <Dialog
      v-if="discard.dialog.value"
      :title="discard.dialog.value.title"
      :body="discard.dialog.value.body"
      :confirm-label="discard.dialog.value.confirm"
      variant="destructive"
      data-testid="discard-dialog"
      @confirm="discard.confirm()"
      @cancel="discard.cancel()"
    />
  </div>
</template>
