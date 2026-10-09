<script setup lang="ts">
// The window: top bar, the row of tabs, the sidebar where the tab shown has one (its rail and its
// docked panel), the layout of the tab shown, status bar, palette and toasts, plus the global
// shortcuts, the window width the review rail collapse depends on, the drop target, the watcher
// of the open repository, and the launch: the projects load, a settings file of a version before
// projects takes its one-time step, and the open project reopens on the repository it showed
// while the index loads beside it.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import BranchDialogs from "@/branches/BranchDialogs.vue";
import KeptStashBanner from "@/branches/KeptStashBanner.vue";
import OperationBanner from "@/branches/OperationBanner.vue";
import ChangesLayout from "@/changes/ChangesLayout.vue";
import { useSyncActions } from "@/remotes/useSyncActions";
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
import { isOverlayTarget, outsideOverlays, shortcutRegistry } from "@/shortcuts/registry";
import { installShortcuts, useShortcut } from "@/shortcuts/useShortcut";
import { useBackgroundFetchStore } from "@/stores/backgroundFetch";
import { useIndexStore } from "@/stores/index";
import { useOperationsStore } from "@/stores/operations";
import { useRemotesStore } from "@/stores/remotes";
import { useSequencerStore } from "@/stores/sequencer";
import { useStashStore } from "@/stores/stash";
import { usePickerStore } from "@/stores/picker";
import { useRecentBranchesStore } from "@/stores/recentBranches";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { useProjectsStore } from "@/stores/projects";
import { useBulkStore } from "@/stores/bulk";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useShellStore } from "@/stores/shell";
import { useTabsStore } from "@/stores/tabs";
import { useWorktreesStore } from "@/stores/worktrees";
import { useSettingsStore } from "@/stores/settings";
import { useSettingsScreenStore } from "@/stores/settingsScreen";
import SettingsLayout from "@/settings/SettingsLayout.vue";
import AddWorktreeDialog from "@/worktrees/AddWorktreeDialog.vue";
import WorktreesLayout from "@/worktrees/WorktreesLayout.vue";

import GraphFocusLayout from "./GraphFocusLayout.vue";
import ReviewFocusLayout from "./ReviewFocusLayout.vue";
import SidebarPanel from "./SidebarPanel.vue";
import SidebarRail from "./SidebarRail.vue";
import StatusBar from "./StatusBar.vue";
import { TAB_PANEL_ID, tabElementId } from "./tabIds";
import TabRow from "./TabRow.vue";
import TextMenu from "./TextMenu.vue";
import ToastHost from "./ToastHost.vue";
import TopBar from "./TopBar.vue";
import { useExternal } from "./useExternal";
import { useOpenFolder } from "./useOpenFolder";
import { useRepoWatcher } from "./useRepoWatcher";
import { useNativeMenu, type TextMenuRequest } from "./useNativeMenu";
import { useZoom } from "./useZoom";

const shell = useShellStore();
const tabs = useTabsStore();
const repo = useRepoStore();
const index = useIndexStore();
const projects = useProjectsStore();
const bulk = useBulkStore();
const projectDialogs = useProjectDialogsStore();
const worktrees = useWorktreesStore();
const settingsScreen = useSettingsScreenStore();
const settings = useSettingsStore();
const reviewStore = useReviewStore();
const picker = usePickerStore();
const remotes = useRemotesStore();
const stash = useStashStore();
const sequencer = useSequencerStore();
const operations = useOperationsStore();
// Made with the shell, so the recent branches are read with the first listing of the refs and
// the palette's "Checkout previous branch" has them when it opens.
useRecentBranchesStore();
const { openFolder, addFolder } = useOpenFolder();
const external = useExternal();
const syncActions = useSyncActions();
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
/** A comparison's tab: its layout from the moment its repository starts to open. */
const compareMode = computed(
  () =>
    shell.layoutMode === "compare" &&
    (repo.state.kind === "ready" || repo.state.kind === "opening"),
);
/** The row of tabs: while there is more than one, always in a project (at launch, once the
 * project is open), at Home while the settings' tab is open beside Home's. */
const tabRowShown = computed(
  () => tabs.row.length > 1 && (projects.active !== null || settings.values.activeProject === null),
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
// Not behind a dialog, a menu or the palette: the panel would take the focus from the overlay.
// Closing it from inside gives the layout's list the focus, which would fall to the body.
useShortcut(
  "toggle-sidebar",
  outsideOverlays(() => {
    const inside = document.activeElement?.closest("[data-sidebar-panel]") != null;
    shell.toggleSidebar();
    if (inside && !shell.sidebarOpen) focusLayout(true);
  }),
);
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
// The tabs' keys act on the window, never behind a dialog, a menu or the palette; ⌘W on the
// project's tab closes nothing, and the webview never sees it.
useShortcut(
  "next-tab",
  outsideOverlays(() => tabs.step(1)),
);
useShortcut(
  "previous-tab",
  outsideOverlays(() => tabs.step(-1)),
);
useShortcut(
  "close-tab",
  outsideOverlays(() => void tabs.closeActive()),
);
useShortcut("next-project-repo", () => void projects.openNeighbour(1));
useShortcut("previous-project-repo", () => void projects.openNeighbour(-1));
// Fetch and Pull as the top bar's buttons do, a toast saying why when they cannot; neither acts
// behind a dialog or a menu, nor in the Overview, which shows no such buttons and whose own
// toolbar fetches and pulls its repositories. ⇧⌘P opens the push dialog, where ↵ confirms,
// rather than pushing at once: it is VS Code's command palette key, and a press from that habit
// must not push.
const syncKey = (action: "fetch" | "pull") =>
  outsideOverlays(() => {
    if (shell.layoutMode !== "overview") syncActions.act(action);
  });
useShortcut("fetch", syncKey("fetch"));
useShortcut("pull", syncKey("pull"));
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
// The open project's fetch in the background runs while the shell does.
const backgroundFetch = useBackgroundFetchStore();
let stopBackgroundFetch: (() => void) | undefined;
const onResize = () => shell.setWindowWidth(window.innerWidth);
// The window coming back (focused, or shown again) reads the review's notes again: an agent
// may have resolved or written some meanwhile.
const onFocus = () => reviewStore.refreshAnnotations();
const onVisibility = () => {
  if (document.visibilityState === "visible") reviewStore.refreshAnnotations();
};

onMounted(() => {
  uninstall = installShortcuts(window);
  onResize();
  window.addEventListener("resize", onResize);
  window.addEventListener("keydown", onEscape);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibility);
  stopBackgroundFetch = backgroundFetch.begin();
  void launch();
});

onBeforeUnmount(() => {
  uninstall?.();
  stopBackgroundFetch?.();
  window.removeEventListener("resize", onResize);
  window.removeEventListener("keydown", onEscape);
  window.removeEventListener("focus", onFocus);
  document.removeEventListener("visibilitychange", onVisibility);
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
  tabs.prune(projects.projects.map((project) => project.id));
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

/**
 * Another tab shown (a click, Ctrl Tab, ⌘W): the layout it shows takes the focus on its list
 * when the one it replaced took the focus with it. Between two comparisons the layout stays, and
 * so does the focus; ← and → keep it on the row.
 */
watch(
  () => tabs.activeKey,
  () => focusLayout(),
);

/**
 * The layout shown takes the focus on its list, on the next tick, when nothing holds it. Handed
 * over from the sidebar's panel (`fromPanel`: Escape there, ⌘B closing it, the dashboard's icon),
 * the panel lets the focus go first, so the layouts that wait for their rows take it once they
 * arrive. Nothing takes it while the panel holds it across a reload of its list.
 */
function focusLayout(fromPanel = false): void {
  const held = document.activeElement;
  if (fromPanel && held instanceof HTMLElement && held.closest("[data-sidebar-panel]")) {
    held.blur();
  }
  void nextTick(() => {
    if (shell.sidebarFocusHeld) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    if (reviewMode.value) reviewLayout.value?.focusFiles();
    else if (compareMode.value) compareLayout.value?.focusSides();
    else if (worktreesMode.value) worktreesLayout.value?.focusRows();
    else if (settingsMode.value) settingsLayout.value?.focus();
    else if (changesMode.value) changesLayout.value?.focusLists();
    else if (projectMode.value) projectLayout.value?.focus();
    else graphLayout.value?.focusRows();
  });
}

/** The tab row holds the focus: its arrows move between the tabs and keep it there. */
function rowHoldsFocus(): boolean {
  return document.activeElement?.closest('[data-testid="tab-row"]') != null;
}

/** The commit rows take the focus on the next tick, when nothing else holds it. */
function focusGraphRows(): void {
  void nextTick(() => {
    if (shell.sidebarFocusHeld) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    graphLayout.value?.focusRows();
  });
}

// Review focus starts on the files list, so j/k work at once (the status bar says so).
watch(reviewMode, (on) => {
  if (!on) return;
  void nextTick(() => {
    if (!rowHoldsFocus()) reviewLayout.value?.focusFiles();
  });
});

// The comparison starts on the "Only in A" list for the same reason.
watch(compareMode, (on) => {
  if (!on) return;
  void nextTick(() => {
    if (!rowHoldsFocus()) compareLayout.value?.focusSides();
  });
});

// The dashboard starts on its rows ("j/k worktrees"); the settings on their first field.
watch(worktreesMode, (on) => {
  if (!on) return;
  void nextTick(() => {
    if (!rowHoldsFocus()) worktreesLayout.value?.focusRows();
  });
});
watch(settingsMode, (on) => {
  if (!on) return;
  void nextTick(() => {
    if (!rowHoldsFocus()) settingsLayout.value?.focus();
  });
});

// The changes screen starts on its lists ("j/k files", "s stage"), and so does the folder view.
watch(changesMode, (on) => {
  if (!on) return;
  void nextTick(() => {
    if (!rowHoldsFocus()) changesLayout.value?.focusLists();
  });
});
watch(projectMode, (on) => {
  if (!on) return;
  void nextTick(() => {
    if (!rowHoldsFocus()) projectLayout.value?.focus();
  });
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
      :settings-shown="shell.layoutMode === 'settings'"
      :show-sync="repo.state.kind === 'ready' && repo.refsLoaded && shell.layoutMode !== 'overview'"
      @open-folder="() => void openFolder()"
      @open-palette="shell.openPalette()"
      @open-settings="() => void shell.setLayoutMode('settings')"
    />
    <TabRow v-if="tabRowShown" @shown="focusLayout" />
    <OperationBanner />
    <KeptStashBanner @released="focusLayout" />
    <div class="relative flex min-h-0 flex-1">
      <SidebarRail v-if="shell.sidebarView !== null" />
      <!-- The panel follows its rail in the tab order, before the layout beside it. The layouts
           paint in a stacking context of their own, so their raised parts (the graph's canvas,
           the graph rail's ring) stay under the menus the panel opens over them. -->
      <SidebarPanel
        v-if="shell.sidebarOpen"
        :id="shell.sidebarSection"
        :key="shell.sidebarSection"
        @leave="focusLayout(true)"
      />
      <div
        :id="TAB_PANEL_ID"
        class="isolate flex min-h-0 min-w-0 flex-1"
        :role="tabRowShown ? 'tabpanel' : undefined"
        :aria-labelledby="tabRowShown ? tabElementId(tabs.activeKey) : undefined"
      >
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
      </div>
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
    <ToastHost @released="focusLayout" />
    <TextMenu v-if="textMenu" v-bind="textMenu" @close="textMenu = null" />
  </div>
</template>
