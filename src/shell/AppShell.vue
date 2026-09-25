<script setup lang="ts">
// The window: top bar, the layout of the active mode, status bar, palette and toasts, plus
// the global shortcuts, the window width the review rail collapse depends on, the drop
// target, the watcher of the open repository, and the launch: the index loads while the
// last repository reopens.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import BranchDialogs from "@/branches/BranchDialogs.vue";
import OperationBanner from "@/branches/OperationBanner.vue";
import ChangesLayout from "@/changes/ChangesLayout.vue";
import NetworkDialog from "@/remotes/NetworkDialog.vue";
import RemotesSheet from "@/remotes/RemotesSheet.vue";
import StashSheet from "@/stash/StashSheet.vue";
import DropTarget from "@/discovery/DropTarget.vue";
import { useDragDrop } from "@/discovery/useDragDrop";
import type { FileChange } from "@/ipc/schemas";
import PaletteOverlay from "@/palette/PaletteOverlay.vue";
import CompareLayout from "@/compare/CompareLayout.vue";
import PickerOverlay from "@/picker/PickerOverlay.vue";
import { baseName, shortHash } from "@/shell/format";
import { isOverlayTarget } from "@/shortcuts/registry";
import { installShortcuts, useShortcut } from "@/shortcuts/useShortcut";
import { useChangesStore } from "@/stores/changes";
import { useIndexStore } from "@/stores/index";
import { useOperationsStore } from "@/stores/operations";
import { useRemotesStore } from "@/stores/remotes";
import { useSequencerStore } from "@/stores/sequencer";
import { useStashStore } from "@/stores/stash";
import { usePickerStore } from "@/stores/picker";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { useToastsStore } from "@/stores/toasts";
import { useWorktreesStore } from "@/stores/worktrees";
import { useSettingsScreenStore } from "@/stores/settingsScreen";
import SettingsLayout from "@/settings/SettingsLayout.vue";
import type { SidebarTab } from "@/stores/shell";
import AddWorktreeDialog from "@/worktrees/AddWorktreeDialog.vue";
import WorktreesLayout from "@/worktrees/WorktreesLayout.vue";

import { errorText } from "./errorMessage";
import GraphFocusLayout from "./GraphFocusLayout.vue";
import ReviewFocusLayout from "./ReviewFocusLayout.vue";
import Sidebar from "./Sidebar.vue";
import SidebarRail from "./SidebarRail.vue";
import StatusBar from "./StatusBar.vue";
import TextMenu from "./TextMenu.vue";
import ToastHost from "./ToastHost.vue";
import TopBar from "./TopBar.vue";
import { useExternal } from "./useExternal";
import { useOpenFolder } from "./useOpenFolder";
import { useRepoWatcher } from "./useRepoWatcher";
import { useNativeMenu, type TextMenuRequest } from "./useNativeMenu";
import { useZoom } from "./useZoom";

const { t } = useI18n();
const shell = useShellStore();
const repo = useRepoStore();
const index = useIndexStore();
const settings = useSettingsStore();
const toasts = useToastsStore();
const changes = useChangesStore();
const worktrees = useWorktreesStore();
const settingsScreen = useSettingsScreenStore();
const reviewStore = useReviewStore();
const picker = usePickerStore();
const remotes = useRemotesStore();
const stash = useStashStore();
const sequencer = useSequencerStore();
const operations = useOperationsStore();
const { openFolder } = useOpenFolder();
const external = useExternal();
const { dragging } = useDragDrop((path) => void index.openFolder(path));
useRepoWatcher();
const graphLayout = ref<{ focusRows(): void } | null>(null);
const reviewLayout = ref<{ focusFiles(): void } | null>(null);
const compareLayout = ref<{ focusSides(): void } | null>(null);
const worktreesLayout = ref<{ focusRows(): void } | null>(null);
const settingsLayout = ref<{ focus(): void } | null>(null);
const changesLayout = ref<{ focusLists(): void } | null>(null);

const repositoryName = computed(() => (repo.repo ? baseName(repo.repo.root) : null));
const reviewMode = computed(() => shell.layoutMode === "review" && repo.state.kind === "ready");
const compareMode = computed(
  () =>
    shell.layoutMode === "compare" &&
    repo.state.kind === "ready" &&
    settings.values.compare !== null,
);
const worktreesMode = computed(
  () => shell.layoutMode === "worktrees" && repo.state.kind === "ready",
);
const settingsMode = computed(() => shell.layoutMode === "settings");
const changesMode = computed(() => shell.layoutMode === "changes" && repo.state.kind === "ready");
/**
 * One sidebar for every layout but review focus and the settings (which show the rail), so
 * switching layouts keeps its filter, its lists and the focus of a tab that switched to the
 * dashboard.
 */
const showSidebar = computed(
  () =>
    repo.state.kind !== "empty" &&
    !shell.sidebarCollapsed &&
    !reviewMode.value &&
    !settingsMode.value,
);

/** A rail icon expands the sidebar on its tab; from review focus or the settings that means leaving them. */
async function selectRailTab(tab: SidebarTab): Promise<void> {
  if (reviewMode.value || settingsMode.value) await shell.setLayoutMode("graph");
  await shell.expandSidebar(tab);
}

/** "Compare with…": the selected commit in graph focus, else the current branch, as A. */
function compareWith(): void {
  if (repo.state.kind !== "ready") return;
  const commit = shell.layoutMode === "graph" ? repo.selectedCommit : undefined;
  const branch = repo.currentBranch;
  const other = commit
    ? { kind: "revision" as const, rev: commit.hash, label: shortHash(commit.hash) }
    : branch
      ? { kind: "revision" as const, rev: branch.fullName, label: branch.name }
      : null;
  if (other) picker.open({ kind: "compare", side: "b", other });
}

useZoom();
/* The webview's own menu never opens; selected text gets the app's Copy menu. */
const textMenu = ref<TextMenuRequest | null>(null);
useNativeMenu((request) => (textMenu.value = request));
useShortcut("palette", () => shell.togglePalette());
useShortcut("graph-focus", () => void shell.setLayoutMode("graph"));
useShortcut("review-focus", () => void shell.setLayoutMode("review"));
useShortcut("toggle-sidebar", () => void shell.toggleSidebar());
useShortcut("open-terminal", () => void external.openTerminal());
useShortcut("open-editor", () => void external.openEditor());
useShortcut("compare-with", compareWith);
useShortcut("add-worktree", () => {
  if (repo.state.kind === "ready") worktrees.openAdd();
});
useShortcut("settings", () => void shell.setLayoutMode("settings"));
useShortcut("changes-focus", () => {
  if (repo.state.kind === "ready") void shell.setLayoutMode("changes");
});
useShortcut("diff-from", () => {
  if (repo.state.kind === "ready") picker.open({ kind: "diff-from" });
});
useShortcut("push", () => {
  const branch = repo.currentBranch?.name;
  if (repo.state.kind === "ready" && branch) remotes.ask({ kind: "push", branch });
});

/** Escape outside every overlay cancels the network command in flight ("esc cancel push"). */
function onEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape" || !operations.current?.cancellable) return;
  if (isOverlayTarget(event.target) || isOverlayTarget(document.activeElement)) return;
  void remotes.cancel();
}

let uninstall: (() => void) | undefined;
const onResize = () => shell.setWindowWidth(window.innerWidth);

onMounted(() => {
  uninstall = installShortcuts(window);
  onResize();
  window.addEventListener("resize", onResize);
  window.addEventListener("keydown", onEscape);
  void launch();
});

onBeforeUnmount(() => {
  uninstall?.();
  window.removeEventListener("resize", onResize);
  window.removeEventListener("keydown", onEscape);
});

/** The index loads while the last repository reopens; a gone one leaves home flagged. */
async function launch(): Promise<void> {
  // The stored shortcut overrides and git executable apply before anything runs git.
  settingsScreen.applyOverrides();
  await settingsScreen.applyAtLaunch();
  void index.load();
  const last = settings.values.lastRepository;
  if (!last) return;
  const failed = await index.restore(last);
  if (failed) {
    const text = errorText(failed, last);
    toasts.push({ kind: "error", message: t(text.key, text.params), output: failed.detail });
  }
}

// The sidebar follows the repository: the Repos tab on failure and at home, the branches
// once open, unless the dashboard is being restored (its tab keeps it up).
watch(
  () => repo.state.kind,
  (kind) => {
    if (kind === "error" || kind === "empty") shell.setSidebarTab("repos");
    if (kind === "ready") {
      shell.setSidebarTab(shell.layoutMode === "worktrees" ? "worktrees" : "branches");
      // An operation stopped before the app opened the repository shows its banner at once.
      void sequencer.load();
    }
  },
);

// Keyboard focus lands on the commit rows as soon as the first page selects a commit, unless
// something else holds the focus: the search or a filter the user is typing in, or the branch
// list whose selection restarted the walk. The home screen's controls are gone by then, so an
// open from there leaves the focus on the body.
watch(
  () => repo.selectedIndex,
  (index, previous) => {
    if (index >= 0 && previous < 0 && shell.layoutMode === "graph") {
      void nextTick(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        graphLayout.value?.focusRows();
      });
    }
  },
);

// Review focus starts on the files list, so j/k work at once (the status bar says so).
watch(reviewMode, (on) => {
  if (on) void nextTick(() => reviewLayout.value?.focusFiles());
});

// The comparison starts on the "Only in A" list for the same reason.
watch(compareMode, (on) => {
  if (on) void nextTick(() => compareLayout.value?.focusSides());
});

// The dashboard starts on its rows ("j/k worktrees"); the settings on their first field.
watch(worktreesMode, (on) => {
  if (on) void nextTick(() => worktreesLayout.value?.focusRows());
});
watch(settingsMode, (on) => {
  if (on) void nextTick(() => settingsLayout.value?.focus());
});

// The changes screen starts on its lists ("j/k files", "s stage").
watch(changesMode, (on) => {
  if (on) void nextTick(() => changesLayout.value?.focusLists());
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
      :changed-count="changes.counts?.changed ?? 0"
      :can-show-changes="repo.state.kind === 'ready'"
      @open-folder="() => void openFolder()"
      @open-palette="shell.openPalette()"
      @set-layout-mode="(mode) => void shell.setLayoutMode(mode)"
    />
    <OperationBanner />
    <div class="relative flex min-h-0 flex-1">
      <Sidebar v-if="showSidebar" />
      <SidebarRail
        v-else
        :active="settingsMode ? null : shell.sidebarTab"
        @select="(tab) => void selectRailTab(tab)"
      />
      <ReviewFocusLayout v-if="reviewMode" ref="reviewLayout" />
      <CompareLayout v-else-if="compareMode" ref="compareLayout" />
      <WorktreesLayout v-else-if="worktreesMode" ref="worktreesLayout" />
      <SettingsLayout v-else-if="settingsMode" ref="settingsLayout" />
      <ChangesLayout v-else-if="changesMode" ref="changesLayout" />
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
    <PickerOverlay v-if="picker.mode" />
    <AddWorktreeDialog
      v-if="worktrees.addOpen && repo.state.kind === 'ready'"
      @close="worktrees.closeAdd()"
    />
    <BranchDialogs v-if="repo.state.kind === 'ready'" />
    <NetworkDialog
      v-if="remotes.prompt && remotes.prompt.kind !== 'removeRemote'"
      :mode="remotes.prompt.kind"
      :branch="remotes.prompt.branch"
    />
    <RemotesSheet v-if="remotes.sheetOpen" />
    <StashSheet v-if="stash.sheetOpen" />
    <ToastHost />
    <TextMenu v-if="textMenu" v-bind="textMenu" @close="textMenu = null" />
  </div>
</template>
