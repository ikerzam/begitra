<script setup lang="ts">
// The folder view: the list panel (the folder with its number of repositories
// with changes and the refresh button, a section per repository with changes, the group of the
// others, and the commit box of the repository the selection is in), the divider of the
// changes screen, and the viewer of the selected file. j and k walk the rows of every open
// section in order; s, u and Backspace act on the picked lines, else on the selected file, in
// its repository; ⌘↵ commits the box's repository. A discard confirms once, as on the changes
// screen.

import { ChevronDown, ChevronRight, RefreshCw } from "@lucide/vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import ChangesScope from "@/changes/ChangesScope.vue";
import ChangesViewer from "@/changes/ChangesViewer.vue";
import CommitBox from "@/changes/CommitBox.vue";
import { useDiscardDialog } from "@/changes/useDiscardDialog";
import Button from "@/components/Button.vue";
import Dialog from "@/components/Dialog.vue";
import EmptyState from "@/components/EmptyState.vue";
import IconButton from "@/components/IconButton.vue";
import PanelHeader from "@/components/PanelHeader.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import PaneResizer from "@/shell/PaneResizer.vue";
import { useShortcut } from "@/shortcuts/useShortcut";
import { useFolderStore } from "@/stores/folder";
import { useIndexStore } from "@/stores/index";
import { paneLimits, useShellStore } from "@/stores/shell";

import FolderSection from "./FolderSection.vue";

interface SectionHandle {
  moveFile(step: 1 | -1): boolean;
  selectEdge(edge: "first" | "last"): void;
}

const { t, n } = useI18n();
const folder = useFolderStore();
const index = useIndexStore();
const shell = useShellStore();
const format = useDiscoveryFormat();
const discard = useDiscardDialog();
const viewer = ref<{ actOnSelection(action: "stage" | "unstage" | "discard"): boolean } | null>(
  null,
);
const sections = new Map<string, SectionHandle>();
const listsWidth = computed(() => `${shell.paneSizes.files}px`);
const shownFolder = computed(() => format.displayPath(folder.folder ?? ""));

/** Clean and unread repositories together, in path order. */
const grouped = computed(() =>
  [...folder.clean, ...folder.checking].sort((a, b) => a.root.localeCompare(b.root)),
);
const groupLabel = computed(() => {
  const clean = folder.clean.length;
  const reading = folder.checking.length;
  const parts: string[] = [];
  if (clean > 0) parts.push(t("folder.clean", { n: n(clean) }, clean));
  if (reading > 0) parts.push(t("folder.reading", { n: n(reading) }, reading));
  return parts.join(" · ");
});

/** The box names the repository it commits and its branch. */
const commitTarget = computed(() => {
  const active = folder.active;
  if (!active) return "";
  return active.branch ? `${active.name} · ${active.branch}` : active.name;
});

function setSection(root: string, handle: unknown): void {
  if (handle) sections.set(root, handle as SectionHandle);
  else sections.delete(root);
}

/** The open sections, the order j and k walk. */
const walked = computed(() =>
  folder.sections.filter((section) => !folder.collapsed.has(section.root)),
);

/** Enters the section after (or before) `from`, on its first (or last) row. */
function enterNext(from: string, step: 1 | -1): void {
  const order = walked.value;
  const at = order.findIndex((section) => section.root === from);
  const next = order[at + step];
  if (!next) return;
  folder.activate(next.root);
  void nextTick(() => sections.get(next.root)?.selectEdge(step === 1 ? "first" : "last"));
}

/** j/k from anywhere on the screen: the selection moves on, into the next section at its end. */
function moveFile(step: 1 | -1): void {
  const active = folder.active;
  if (!active) return;
  if (folder.collapsed.has(active.root) || !sections.get(active.root)?.moveFile(step)) {
    enterNext(active.root, step);
  }
}

/** s, u, Backspace: the picked lines first, else the selected file of the matching list. */
function actOnSelected(action: "stage" | "unstage" | "discard"): void {
  const view = folder.active?.view;
  if (!view || view.busy !== null || discard.pending.value !== null) return;
  if (viewer.value?.actOnSelection(action)) return;
  const current = view.selected;
  const file = view.selectedFile;
  if (!current || !file) return;
  if (action === "stage" && current.list === "unstaged") void view.stage([file.path]);
  else if (action === "unstage" && current.list === "staged") void view.unstage([file.path]);
  else if (action === "discard" && current.list === "unstaged") {
    discard.ask(view, { kind: "files", files: [file] });
  }
}

async function openRepository(root: string): Promise<void> {
  await index.open(root);
  await shell.setLayoutMode("graph");
}

useShortcut("next-file", () => moveFile(1));
useShortcut("previous-file", () => moveFile(-1));
useShortcut("stage-file", () => actOnSelected("stage"));
useShortcut("unstage-file", () => actOnSelected("unstage"));
useShortcut("discard-file", () => actOnSelected("discard"));
useShortcut("commit", () => void folder.active?.view.commit());
// No key of its own: the palette's "Discard all…" runs it on the box's repository.
useShortcut("discard-all", () => {
  const view = folder.active?.view;
  if (view) discard.ask(view, { kind: "files", files: view.unstaged.files });
});

onMounted(() => folder.show());
onBeforeUnmount(() => folder.hide());
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1" data-testid="folder-view">
    <div
      class="flex shrink-0 flex-col border-r border-line"
      :style="{ width: listsWidth }"
      data-testid="folder-panel"
    >
      <PanelHeader :title="shownFolder" :count="folder.sections.length">
        <template #actions>
          <IconButton
            :label="t('folder.refresh')"
            :icon="RefreshCw"
            data-testid="folder-refresh"
            @click="folder.refresh()"
          />
        </template>
      </PanelHeader>
      <div class="min-h-0 flex-1 overflow-y-auto" data-testid="folder-sections">
        <template v-if="folder.state === 'scanning' || folder.state === 'loading'">
          <p class="px-3 pt-2 pb-1 text-sm text-fg-muted" data-testid="folder-loading">
            {{
              folder.state === "scanning"
                ? t("folder.looking", { folder: shownFolder })
                : t("folder.readingLine", { n: n(folder.checking.length) }, folder.checking.length)
            }}
          </p>
          <SkeletonRow v-for="k in 4" :key="k" :index="k" height="tree" />
        </template>
        <EmptyState
          v-else-if="folder.state === 'empty'"
          :message="t('folder.empty', { folder: shownFolder })"
          data-testid="folder-empty"
        >
          <Button variant="secondary" data-testid="folder-scan-again" @click="folder.scanAgain()">
            {{ t("folder.scanAgain") }}
          </Button>
        </EmptyState>
        <EmptyState
          v-else-if="folder.state === 'clean'"
          :message="t('folder.allClean', { n: n(folder.clean.length) }, folder.clean.length)"
          data-testid="folder-clean"
        />
        <FolderSection
          v-for="section in folder.sections"
          :key="section.root"
          :ref="(handle) => setSection(section.root, handle)"
          :repository="section"
          :collapsed="folder.collapsed.has(section.root)"
          :active="folder.active?.root === section.root"
          @toggle="folder.toggleSection(section.root)"
          @open="() => void openRepository(section.root)"
          @activate="folder.activate(section.root)"
          @discard="(files) => discard.ask(section.view, { kind: 'files', files })"
          @edge="(direction) => enterNext(section.root, direction)"
        />
        <div
          v-if="grouped.length > 0 && folder.state !== 'loading'"
          class="flex flex-col"
          data-testid="folder-group"
        >
          <button
            type="button"
            class="flex h-control items-center gap-2 px-2 text-left text-sm text-fg-muted hover:bg-hover"
            :aria-expanded="folder.groupOpen"
            data-testid="folder-group-toggle"
            @click="folder.toggleGroup()"
          >
            <component
              :is="folder.groupOpen ? ChevronDown : ChevronRight"
              :size="16"
              :stroke-width="1.5"
              aria-hidden="true"
            />
            <span class="truncate">{{ groupLabel }}</span>
          </button>
          <ul v-if="folder.groupOpen" class="flex flex-col pb-1" data-testid="folder-group-list">
            <li
              v-for="repository in grouped"
              :key="repository.root"
              class="flex h-row-tree items-center gap-2 pr-2 pl-6 text-md"
              data-testid="folder-group-row"
            >
              <span class="min-w-0 truncate text-fg-secondary" :data-tooltip="repository.root">
                {{ repository.name }}
              </span>
              <span class="ml-auto shrink-0 text-sm text-fg-muted">
                {{
                  repository.view.counts === null ? t("folder.readingOne") : t("folder.noChanges")
                }}
              </span>
            </li>
          </ul>
        </div>
      </div>
      <ChangesScope v-if="folder.active" :key="folder.active.root" :view="folder.active.view">
        <CommitBox :target="commitTarget" />
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
        @discard="(request) => folder.active && discard.ask(folder.active.view, request)"
      />
    </ChangesScope>
    <EmptyState v-else class="flex-1" :message="t('changes.noFile')" />
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
