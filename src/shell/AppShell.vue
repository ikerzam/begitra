<script setup lang="ts">
// The window: top bar, the layout of the active mode, status bar, palette and toasts, plus
// the global shortcuts, the window width the review rail collapse depends on, the drop
// target, the watcher of the open repository, and the launch: the index loads while the
// last repository reopens.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import DropTarget from "@/discovery/DropTarget.vue";
import { useDragDrop } from "@/discovery/useDragDrop";
import type { FileChange } from "@/ipc/schemas";
import PaletteOverlay from "@/palette/PaletteOverlay.vue";
import { baseName } from "@/shell/format";
import { isEditableTarget } from "@/shortcuts/registry";
import { installShortcuts, useShortcut } from "@/shortcuts/useShortcut";
import { useIndexStore } from "@/stores/index";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { useToastsStore } from "@/stores/toasts";

import { errorText } from "./errorMessage";
import GraphFocusLayout from "./GraphFocusLayout.vue";
import ReviewFocusLayout from "./ReviewFocusLayout.vue";
import StatusBar from "./StatusBar.vue";
import ToastHost from "./ToastHost.vue";
import TopBar from "./TopBar.vue";
import { useExternal } from "./useExternal";
import { useOpenFolder } from "./useOpenFolder";
import { useRepoWatcher } from "./useRepoWatcher";

const { t } = useI18n();
const shell = useShellStore();
const repo = useRepoStore();
const index = useIndexStore();
const settings = useSettingsStore();
const toasts = useToastsStore();
const reviewStore = useReviewStore();
const { openFolder } = useOpenFolder();
const external = useExternal();
const { dragging } = useDragDrop((path) => void index.open(path));
useRepoWatcher();
const graphLayout = ref<{ focusRows(): void } | null>(null);
const reviewLayout = ref<{ focusFiles(): void } | null>(null);

const repositoryName = computed(() => (repo.repo ? baseName(repo.repo.root) : null));
const reviewMode = computed(() => shell.layoutMode === "review" && repo.state.kind === "ready");

useShortcut("palette", () => shell.togglePalette());
useShortcut("graph-focus", () => void shell.setLayoutMode("graph"));
useShortcut("review-focus", () => void shell.setLayoutMode("review"));
useShortcut("toggle-sidebar", () => void shell.toggleSidebar());
useShortcut("open-terminal", () => void external.openTerminal());
useShortcut("open-editor", () => void external.openEditor());

let uninstall: (() => void) | undefined;
const onResize = () => shell.setWindowWidth(window.innerWidth);

onMounted(() => {
  uninstall = installShortcuts(window);
  onResize();
  window.addEventListener("resize", onResize);
  void launch();
});

onBeforeUnmount(() => {
  uninstall?.();
  window.removeEventListener("resize", onResize);
});

/** The index loads while the last repository reopens; a gone one leaves home flagged. */
async function launch(): Promise<void> {
  void index.load();
  const last = settings.values.lastRepository;
  if (!last) return;
  const failed = await index.restore(last);
  if (failed) {
    const text = errorText(failed, last);
    toasts.push({ kind: "error", message: t(text.key, text.params), output: failed.detail });
  }
}

// The sidebar follows the repository: the Repos tab on failure, the branches once open.
watch(
  () => repo.state.kind,
  (kind) => {
    if (kind === "error") shell.setSidebarTab("repos");
    if (kind === "ready") shell.setSidebarTab("branches");
  },
);

// Keyboard focus lands on the commit rows as soon as the first page selects a commit, unless
// the user is already typing somewhere (the search or a filter while the repository opens).
watch(
  () => repo.selectedIndex,
  (index, previous) => {
    if (index >= 0 && previous < 0 && shell.layoutMode === "graph") {
      void nextTick(() => {
        if (isEditableTarget(document.activeElement)) return;
        graphLayout.value?.focusRows();
      });
    }
  },
);

// Review focus starts on the files list, so j/k work at once (the status bar says so).
watch(reviewMode, (on) => {
  if (on) void nextTick(() => reviewLayout.value?.focusFiles());
});

/** Switches to review focus, on `file` when the detail tree chose one. */
async function review(file?: FileChange): Promise<void> {
  if (repo.state.kind !== "ready") return;
  if (repo.detail) reviewStore.open(repo.detail.hash, file ?? null);
  await shell.setLayoutMode("review");
}

/** "Remove from list" in the error state: the entry leaves the index and the home shows. */
async function removeFromList(): Promise<void> {
  const state = repo.state;
  if (state.kind === "error") await index.forget(state.path);
  await repo.close();
}
</script>

<template>
  <div class="relative flex h-full min-h-0 flex-col bg-app text-fg" data-testid="app-shell">
    <TopBar
      :repository-name="repositoryName"
      :repository-root="repo.repo?.root ?? null"
      :layout-mode="shell.layoutMode"
      @open-folder="() => void openFolder()"
      @open-palette="shell.openPalette()"
      @set-layout-mode="(mode) => void shell.setLayoutMode(mode)"
    />
    <div class="relative flex min-h-0 flex-1">
      <ReviewFocusLayout v-if="reviewMode" ref="reviewLayout" />
      <GraphFocusLayout
        v-else
        ref="graphLayout"
        @open-folder="() => void openFolder()"
        @review="(file) => void review(file)"
        @remove-from-list="() => void removeFromList()"
      />
      <DropTarget :active="dragging" />
    </div>
    <StatusBar />
    <PaletteOverlay v-if="shell.paletteOpen" />
    <ToastHost />
  </div>
</template>
