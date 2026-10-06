<script setup lang="ts">
// The window: top bar, the layout of the active mode, status bar, palette and toasts, plus
// the global shortcuts, the window width the review rail collapse depends on, the drop
// target, the watcher of the open repository, and the launch: the projects load, a settings
// file of a version before projects takes its one-time step, and the open project reopens on
// the repository it showed while the index loads beside it.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import BranchDialogs from "@/branches/BranchDialogs.vue";
import OperationBanner from "@/branches/OperationBanner.vue";
import ChangesLayout from "@/changes/ChangesLayout.vue";
import NetworkDialog from "@/remotes/NetworkDialog.vue";
import RemoteRefDialog from "@/remotes/RemoteRefDialog.vue";
import RemotesSheet from "@/remotes/RemotesSheet.vue";
import StashSheet from "@/stash/StashSheet.vue";
import DropTarget from "@/discovery/DropTarget.vue";
import { useDragDrop } from "@/discovery/useDragDrop";
import type { FileChange } from "@/ipc/schemas";
import PaletteOverlay from "@/palette/PaletteOverlay.vue";
import CompareLayout from "@/compare/CompareLayout.vue";
import DeleteProjectDialog from "@/project/DeleteProjectDialog.vue";
import EditProjectDialog from "@/project/EditProjectDialog.vue";
import NewProjectDialog from "@/project/NewProjectDialog.vue";
import ProjectLayout from "@/project/ProjectLayout.vue";
import RemoveMemberDialog from "@/project/RemoveMemberDialog.vue";
import PickerOverlay from "@/picker/PickerOverlay.vue";
import { shortHash } from "@/shell/format";
import { isOverlayTarget, shortcutRegistry } from "@/shortcuts/registry";
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
import { useFolderStore } from "@/stores/folder";
import { useProjectsStore } from "@/stores/projects";
import { useBulkStore } from "@/stores/bulk";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useSettingsStore, type SidebarSectionId } from "@/stores/settings";
import { paneLimits, useShellStore } from "@/stores/shell";
import { useWorktreesStore } from "@/stores/worktrees";
import { useSettingsScreenStore } from "@/stores/settingsScreen";
import SettingsLayout from "@/settings/SettingsLayout.vue";
import AddWorktreeDialog from "@/worktrees/AddWorktreeDialog.vue";
import WorktreesLayout from "@/worktrees/WorktreesLayout.vue";

import PaneResizer from "./PaneResizer.vue";
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
const folder = useFolderStore();
const projects = useProjectsStore();
const bulk = useBulkStore();
const projectDialogs = useProjectDialogsStore();
const changes = useChangesStore();
const worktrees = useWorktreesStore();
const settingsScreen = useSettingsScreenStore();
const reviewStore = useReviewStore();
const picker = usePickerStore();
const remotes = useRemotesStore();
const stash = useStashStore();
const sequencer = useSequencerStore();
const operations = useOperationsStore();
const { openFolder, addFolder } = useOpenFolder();
const external = useExternal();
// A folder dropped on the window opens as Open folder… opens it.
const { dragging } = useDragDrop((path) => void projects.openPath(path));
useRepoWatcher();
const graphLayout = ref<{ focusRows(): void } | null>(null);
const reviewLayout = ref<{ focusFiles(): void } | null>(null);
const compareLayout = ref<{ focusSides(): void } | null>(null);
const worktreesLayout = ref<{ focusRows(): void } | null>(null);
const settingsLayout = ref<{ focus(): void } | null>(null);
const changesLayout = ref<{ focusLists(): void } | null>(null);
const projectLayout = ref<{ focus(): void } | null>(null);

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
/** The changes screen: the Changes of a project of one, on its open repository. */
const changesMode = computed(
  () => shell.layoutMode === "changes" && !projects.multi && repo.state.kind === "ready",
);
/**
 * The Overview and the Changes of a project of several (the folder view) show with or without
 * an open repository.
 */
const projectMode = computed(() => projects.view !== null);
/** The Changes toggle's count: the project's repositories' changed files, as far as read. */
const changedCount = computed(() => {
  if (!projects.multi || folder.source !== projects.active?.id) return changes.counts?.changed ?? 0;
  const read = folder.repositories.reduce(
    (sum, repository) => sum + (repository.view.counts?.changed ?? 0),
    0,
  );
  return Math.max(read, changes.counts?.changed ?? 0);
});
/** Home has no sidebar: it shows with a repository or a project open. */
const sidebarAvailable = computed(() => repo.state.kind !== "empty" || projects.active !== null);
/**
 * One sidebar for every layout but review focus and the settings (which show the rail), so
 * switching layouts keeps its filter, its folds and its lists.
 */
const showSidebar = computed(
  () =>
    sidebarAvailable.value && !shell.sidebarCollapsed && !reviewMode.value && !settingsMode.value,
);

/**
 * A rail icon expands the sidebar on its section; from review focus or the settings that means
 * leaving them. The sidebar reveals the section and focuses its list. At Home the icons are
 * disabled: a request there would wait for the next project and take its focus.
 */
function selectRailSection(id: SidebarSectionId): void {
  if (!sidebarAvailable.value) return;
  if (reviewMode.value || settingsMode.value) void shell.setLayoutMode("graph");
  void shell.expandSidebar(id);
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
// ⌘F and F3 never reach the webview, whose own find sees only the rows drawn: the layouts with
// a find (the diff's bar, the graph's search) take them over; elsewhere they do nothing. These
// register in setup, under the layouts' handlers, which mount before the shell does.
const findKeys = ["find", "find-next", "find-previous"].map((id) =>
  shortcutRegistry().register(id, () => undefined),
);
onBeforeUnmount(() => {
  for (const release of findKeys) release();
});
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
  if (repo.state.kind === "ready" || projects.multi) void shell.setLayoutMode("changes");
});
useShortcut("overview-focus", () => {
  if (projects.multi) void shell.setLayoutMode("overview");
});
useShortcut("diff-from", () => {
  if (repo.state.kind === "ready") picker.open({ kind: "diff-from" });
});
useShortcut("next-project-repo", () => void projects.openNeighbour(1));
useShortcut("previous-project-repo", () => void projects.openNeighbour(-1));
useShortcut("push", () => {
  const branch = repo.currentBranch?.name;
  if (repo.state.kind === "ready" && branch) remotes.ask({ kind: "push", branch });
});

/**
 * Escape outside every overlay cancels the network command in flight ("esc cancel push"), or
 * stops a bulk operation.
 */
function onEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  if (isOverlayTarget(event.target) || isOverlayTarget(document.activeElement)) return;
  if (bulk.running) void bulk.stop();
  else if (operations.current?.cancellable) void remotes.cancel();
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

/**
 * The projects load (the repository to reopen is the open project's), a settings file of a
 * version before projects takes its one-time step, and the open project reopens on the
 * repository it showed while the index loads beside it; a project that is gone leaves Home, a
 * repository that cannot be opened leaves the shell in its error state inside the project.
 */
async function launch(): Promise<void> {
  // The stored shortcut overrides and git executable apply before anything runs git.
  settingsScreen.applyOverrides();
  await settingsScreen.applyAtLaunch();
  void index.load();
  await projects.load();
  await projects.migrateSettings();
  await projects.restore();
}

// The Overview of a project that holds one repository or none (its members changed, or a
// stale setting) gives way to the graph once the projects are known.
watch(
  () => [shell.layoutMode, projects.loaded, projects.multi] as const,
  ([mode, loaded, multi]) => {
    if (mode === "overview" && loaded && !multi) void shell.setLayoutMode("graph");
  },
);

// An operation stopped before the app opened the repository shows its banner at once.
watch(
  () => repo.state.kind,
  (kind) => {
    if (kind === "ready") void sequencer.load();
  },
);

// Keyboard focus lands on the commit rows as soon as the first page selects a commit, unless
// something else holds the focus: the search or a filter the user is typing in, or the branch
// list whose selection restarted the walk. The home screen's controls are gone by then, so an
// open from there leaves the focus on the body.
watch(
  () => repo.selectedIndex,
  (index, previous) => {
    if (index >= 0 && previous < 0 && shell.layoutMode === "graph") focusGraphRows();
  },
);

// Graph focus starts on its rows when it comes back from another layout (⌘1, a file's "File
// history"): the layout it left took the focus with it.
watch(
  () => shell.layoutMode,
  (mode, previous) => {
    if (mode === "graph" && previous !== "graph") focusGraphRows();
  },
);

/** The commit rows take the focus on the next tick, when nothing else holds it. */
function focusGraphRows(): void {
  void nextTick(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    graphLayout.value?.focusRows();
  });
}

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

// The changes screen starts on its lists ("j/k files", "s stage"), and so does the folder view.
watch(changesMode, (on) => {
  if (on) void nextTick(() => changesLayout.value?.focusLists());
});
watch(projectMode, (on) => {
  if (on) void nextTick(() => projectLayout.value?.focus());
});

/** Switches to review focus, on `file` when the detail tree chose one. */
async function review(file?: FileChange): Promise<void> {
  if (repo.state.kind !== "ready") return;
  if (repo.detail) reviewStore.open(repo.detail.hash, file ?? null);
  await shell.setLayoutMode("review");
}

/**
 * "Remove from project" in the error state: the repository the project shows leaves it (after
 * the confirmation when it leaves Begitra), and the project shows another one.
 */
function removeFromProject(): void {
  const state = repo.state;
  if (state.kind === "error") projects.askRemoveMember(state.path);
}
</script>

<template>
  <div class="relative flex h-full min-h-0 flex-col bg-app text-fg" data-testid="app-shell">
    <TopBar
      :layout-mode="shell.layoutMode"
      :changed-count="changedCount"
      :can-show-changes="repo.state.kind === 'ready' || projects.multi"
      :can-show-overview="projects.multi"
      @open-folder="() => void openFolder()"
      @open-palette="shell.openPalette()"
      @set-layout-mode="(mode) => void shell.setLayoutMode(mode)"
    />
    <OperationBanner />
    <div class="relative flex min-h-0 flex-1">
      <Sidebar v-if="showSidebar" />
      <PaneResizer
        v-if="showSidebar"
        :size="shell.paneSizes.sidebar"
        :min="paneLimits.sidebar.min"
        :max="paneLimits.sidebar.max"
        :label="t('layout.resizeSidebar')"
        @resize="(px) => void shell.setPaneSize('sidebar', px)"
        @reset="() => void shell.resetPaneSize('sidebar')"
      />
      <SidebarRail v-else :disabled="!sidebarAvailable" @select="selectRailSection" />
      <ReviewFocusLayout v-if="reviewMode" ref="reviewLayout" />
      <CompareLayout v-else-if="compareMode" ref="compareLayout" />
      <WorktreesLayout v-else-if="worktreesMode" ref="worktreesLayout" />
      <SettingsLayout v-else-if="settingsMode" ref="settingsLayout" />
      <ChangesLayout v-else-if="changesMode" ref="changesLayout" />
      <ProjectLayout v-else-if="projectMode" ref="projectLayout" />
      <GraphFocusLayout
        v-else
        ref="graphLayout"
        @open-folder="() => void openFolder()"
        @add-folder="() => void addFolder()"
        @review="(file) => void review(file)"
        @remove-from-project="removeFromProject"
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
      v-if="remotes.prompt && (remotes.prompt.kind === 'push' || remotes.prompt.kind === 'pull')"
      :mode="remotes.prompt.kind"
      :branch="remotes.prompt.branch"
      :remote="remotes.prompt.kind === 'pull' ? remotes.prompt.remote : undefined"
      :remote-branch="remotes.prompt.kind === 'pull' ? remotes.prompt.remoteBranch : undefined"
    />
    <RemoteRefDialog
      v-if="
        remotes.prompt &&
        (remotes.prompt.kind === 'pushTag' || remotes.prompt.kind === 'deleteOnRemote')
      "
    />
    <RemotesSheet v-if="remotes.sheetOpen" />
    <NewProjectDialog v-if="projectDialogs.creating" />
    <EditProjectDialog
      v-if="projectDialogs.editing !== null"
      :id="projectDialogs.editing"
      :key="projectDialogs.editing"
    />
    <DeleteProjectDialog
      v-if="projectDialogs.deleting !== null"
      :id="projectDialogs.deleting"
      :key="`delete:${projectDialogs.deleting}`"
    />
    <RemoveMemberDialog
      v-if="projectDialogs.removing !== null"
      :key="`remove:${projectDialogs.removing}`"
      :path="projectDialogs.removing"
    />
    <StashSheet v-if="stash.sheetOpen" />
    <ToastHost />
    <TextMenu v-if="textMenu" v-bind="textMenu" @close="textMenu = null" />
  </div>
</template>
