// Wires the palette commands and the Repos section to the stores and the shell helpers; the
// overlay only renders.

import { Folder, FolderGit2, Layers, ListTree } from "@lucide/vue";
import { nextTick } from "vue";
import { computed, type ComputedRef } from "vue";

import { useLinks } from "@/remotes/useLinks";
import { useSyncActions } from "@/remotes/useSyncActions";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import { i18n, setLocale } from "@/i18n";
import type { Project } from "@/ipc/schemas";
import { useNotesExport } from "@/review/useNotesExport";
import { folderKey } from "@/shell/format";
import { useExternal } from "@/shell/useExternal";
import { useOpenFolder } from "@/shell/useOpenFolder";
import { useBranchesStore } from "@/stores/branches";
import { useRecentBranchesStore } from "@/stores/recentBranches";
import { useCleanupStore } from "@/stores/cleanup";
import { useIndexStore } from "@/stores/index";
import { useLocalChangesStore } from "@/stores/localChanges";
import { useChangesStore } from "@/stores/changes";
import { useRemotesStore } from "@/stores/remotes";
import { useSequencerStore } from "@/stores/sequencer";
import { useStashStore } from "@/stores/stash";
import { useCompareStore } from "@/stores/compare";
import { usePickerStore } from "@/stores/picker";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { useBulkStore } from "@/stores/bulk";
import { useOverviewStore } from "@/stores/overview";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore, type ProjectMember } from "@/stores/projects";
import { useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { useTabsStore } from "@/stores/tabs";
import { useToastsStore } from "@/stores/toasts";
import { useWorktreesStore } from "@/stores/worktrees";
import { shortcutRegistry } from "@/shortcuts/registry";

import type { PaletteActions } from "./commands";
import type { PaletteRepo } from "./usePalette";

export function usePaletteActions(): PaletteActions {
  const shell = useShellStore();
  const repo = useRepoStore();
  const index = useIndexStore();
  const settings = useSettingsStore();
  const { openFolder, addFolder } = useOpenFolder();
  const external = useExternal();
  const links = useLinks();
  const review = useReviewStore();
  const notesExport = useNotesExport();
  const picker = usePickerStore();
  const compare = useCompareStore();
  const worktrees = useWorktreesStore();
  const changes = useChangesStore();
  const remotes = useRemotesStore();
  const cleanup = useCleanupStore();
  const branches = useBranchesStore();
  const recentBranches = useRecentBranchesStore();
  const toasts = useToastsStore();
  const sequencer = useSequencerStore();
  const localChanges = useLocalChangesStore();
  const stash = useStashStore();
  const projects = useProjectsStore();
  const projectDialogs = useProjectDialogsStore();
  const syncActions = useSyncActions();
  const tabs = useTabsStore();

  return {
    hasRepository: () => repo.state.kind === "ready",
    hasSidebar: () => shell.sidebarView !== null,
    projectPinned: () => projects.active?.pinned ?? null,
    hasFolderProjects: () => projects.folders.length > 0,
    openFolder: async () => {
      await openFolder();
    },
    goToProjects: () => projects.close(),
    scanFolders: () => index.startScan(),
    addFolder: async () => {
      await addFolder();
    },
    pinProject: async (pinned) => {
      const active = projects.active;
      if (active) await projects.setPinned(active.id, pinned);
    },
    setGraphFocus: () => void shell.setLayoutMode("graph"),
    setReviewFocus: () => void shell.setLayoutMode("review"),
    toggleSidebar: () => shell.toggleSidebar(),
    openTerminal: async () => {
      await external.openTerminal();
    },
    openEditor: async () => {
      await external.openEditor();
    },
    revealRepository: async () => {
      const root = repo.repo?.root;
      if (root) await links.reveal(root, root);
    },
    setLocale: async (locale) => {
      await settings.update("locale", locale);
      setLocale(locale);
    },
    diffFrom: () => picker.open({ kind: "diff-from" }),
    reviewWorktree: async () => {
      review.setTarget({ kind: "worktree" });
      await shell.setLayoutMode("review");
    },
    reviewIndex: async () => {
      review.setTarget({ kind: "index" });
      await shell.setLayoutMode("review");
    },
    reviewSelectedCommit: async () => {
      review.setTarget(null);
      await shell.setLayoutMode("review");
    },
    hasSelectedCommit: () => repo.selectedCommit !== undefined,
    copyReviewNotes: notesExport.copyNotes,
    hasReviewNotes: () => notesExport.canCopy.value,
    inReview: () => shell.layoutMode === "review",
    toggleLayout: () => review.setLayout(review.layout === "unified" ? "side-by-side" : "unified"),
    toggleWrap: () => review.setWrap(!review.wrap),
    toggleWhitespace: () => review.setIgnoreWhitespace(!review.ignoreWhitespace),
    toggleWholeFile: () => review.setWholeFile(!review.wholeFile),
    runShortcut: (id) => void shortcutRegistry().run(id),
    shortcutActive: (id) => shortcutRegistry().isActive(id),
    toggleOverview: () => {
      if (shell.reviewRailCollapsed) shell.showReviewRail();
      else shell.hideReviewRail();
    },
    toggleFilter: (key) => review.setFilter(key, !review.filters[key]),
    compareWith: () => void shortcutRegistry().run("compare-with"),
    inComparison: () => shell.layoutMode === "compare",
    swapComparison: () => compare.swap(),
    inGraph: () => shell.layoutMode === "graph" && repo.state.kind === "ready",
    goToHead: () => void shortcutRegistry().run("go-to-head"),
    hasTabs: () => tabs.row.length > 1,
    nextTab: () => tabs.step(1),
    previousTab: () => tabs.step(-1),
    canCloseTab: () => tabs.active !== null,
    closeTab: () => void tabs.closeActive(),
    openComparisonInReview: () => compare.openInReview(),
    showWorktrees: () => worktrees.show(),
    showChanges: () => shell.setLayoutMode("changes"),
    branchAction: (action) => picker.open({ kind: "branch-action", action }),
    hasPreviousBranch: () => recentBranches.previous !== null,
    checkoutPrevious: () => {
      const name = recentBranches.previous;
      if (name !== null) void branches.checkout({ kind: "branch", name });
    },
    undoLastCommit: () => void branches.undoLastCommit(),
    canRedoUndone: () => branches.canRedo,
    redoUndoneCommit: () => void branches.redoUndone(),
    canUndoDiscard: () => toasts.actionIn("discard") !== undefined,
    undoDiscard: () => toasts.actSlot("discard"),
    network: (action) => {
      const branch = repo.currentBranch?.name;
      if (branch) remotes.ask({ kind: action, branch });
    },
    sync: (action) => syncActions.act(action),
    cleanUpBranches: () => void cleanup.open(),
    openRemotes: () => remotes.openSheet(),
    openStashes: () => stash.openSheet(),
    // Conflicts with no operation (a stash that came back with them) have nothing to continue.
    inOperation: () => sequencer.operation !== "none",
    sequencer: (action) => {
      if (action === "abort") sequencer.askAbort();
      else void sequencer.act("continue");
    },
    hasKeptStash: (action) =>
      localChanges.keptShown &&
      sequencer.conflictCount === 0 &&
      (action === "keep" || localChanges.canDrop),
    keptStash: (action) => {
      if (action === "keep") localChanges.forget();
      else localChanges.askDrop();
    },
    inChanges: () => shell.layoutMode === "changes",
    changesAll: (action) => {
      if (action === "stage") void changes.stageAll();
      else if (action === "unstage") void changes.unstageAll();
      else shortcutRegistry().run("discard-all");
    },
    openSettings: () => shell.setLayoutMode("settings"),
    addWorktree: () => worktrees.openAdd(),
    hasPrunableWorktrees: () => worktrees.prunable.length > 0,
    pruneWorktrees: () => worktrees.askPrune(),
    hasActiveProject: () => projects.active !== null,
    hasSeveralRepositories: () => projects.multi,
    newProject: () => projectDialogs.create(),
    editProject: () => {
      const active = projects.active;
      if (active) projectDialogs.edit(active.id);
    },
    showOverview: () => shell.setLayoutMode("overview"),
    fetchProject: async () => {
      if (!projects.multi) return;
      await shell.setLayoutMode("overview");
      // The Overview shows and adopts the project's rows before the fetch counts them.
      await nextTick();
      useOverviewStore().clearSelection();
      useBulkStore().ask("fetch");
    },
    projectNeighbour: async (step) => {
      await projects.openNeighbour(step);
    },
  };
}

/**
 * The Projects section: every project, opening it; the pinned and the recent ones listed while
 * the query is empty. A folder project's context is its folder, a list project's its count.
 */
export function usePaletteProjects(): ComputedRef<PaletteRepo[]> {
  const projects = useProjectsStore();
  const format = useDiscoveryFormat();
  const { t, n } = i18n.global;
  return computed(() => {
    const featured = new Set([...projects.pinned, ...projects.recent].map((p) => p.id));
    return projects.sorted.map((project) => ({
      path: String(project.id),
      name: project.name,
      context:
        project.folder !== null
          ? format.displayPath(project.folder)
          : t("project.repositories", { n: n(project.members.length) }, project.members.length),
      featured: featured.has(project.id),
      icon: project.kind === "folder" ? Folder : Layers,
      run: () => projects.open(project.id),
    }));
  });
}

/**
 * The Repos section: the repositories of every project, each once with its project as the
 * context (the open project for its own members, else the project opened last among those that
 * hold it); the open project's first, in its order, and listed while the query is empty.
 * Choosing one shows it in the open project, or opens its project showing it.
 */
export function usePaletteRepos(): ComputedRef<PaletteRepo[]> {
  const projects = useProjectsStore();
  return computed(() => {
    const listed = new Set<string>();
    const rows: PaletteRepo[] = [];
    const add = (member: ProjectMember, project: Project, featured: boolean): void => {
      const key = folderKey(member.path);
      if (member.missing || listed.has(key)) return;
      listed.add(key);
      rows.push({
        path: member.path,
        name: member.entry?.name ?? member.name,
        context: project.name,
        featured,
        icon: member.entry?.kind === "worktree" ? ListTree : FolderGit2,
        run: () =>
          project.id === projects.active?.id
            ? projects.show(member.path)
            : projects.open(project.id, member.path),
      });
    };
    const open = projects.active;
    if (open) for (const member of projects.members(open)) add(member, open, true);
    const byRecency = [...projects.projects].sort(
      (a, b) => (b.openedAt ?? -1) - (a.openedAt ?? -1) || a.name.localeCompare(b.name),
    );
    for (const project of byRecency) {
      for (const member of projects.members(project)) add(member, project, false);
    }
    const [first, rest] = [rows.filter((row) => row.featured), rows.filter((row) => !row.featured)];
    return [...first, ...rest.sort((a, b) => a.name.localeCompare(b.name))];
  });
}
