// Wires the palette commands and the Repos section to the stores and the shell helpers; the
// overlay only renders.

import { FolderGit2, Layers, ListTree } from "@lucide/vue";
import { nextTick } from "vue";
import { computed, type ComputedRef } from "vue";

import { useAddScanFolder } from "@/discovery/useAddScanFolder";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import { i18n, setLocale } from "@/i18n";
import type { IndexEntry } from "@/ipc/schemas";
import { useNotesExport } from "@/review/useNotesExport";
import { useExternal } from "@/shell/useExternal";
import { useOpenFolder } from "@/shell/useOpenFolder";
import { useIndexStore } from "@/stores/index";
import { useChangesStore } from "@/stores/changes";
import { useRemotesStore } from "@/stores/remotes";
import { useSequencerStore } from "@/stores/sequencer";
import { useStashStore } from "@/stores/stash";
import { useCompareStore } from "@/stores/compare";
import { usePickerStore } from "@/stores/picker";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { useBulkStore } from "@/stores/bulk";
import { useFolderStore } from "@/stores/folder";
import { useOverviewStore } from "@/stores/overview";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";
import { useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { useWorktreesStore } from "@/stores/worktrees";
import { shortcutRegistry } from "@/shortcuts/registry";

import type { PaletteActions } from "./commands";
import type { PaletteRepo } from "./usePalette";

export function usePaletteActions(): PaletteActions {
  const shell = useShellStore();
  const repo = useRepoStore();
  const index = useIndexStore();
  const settings = useSettingsStore();
  const folder = useFolderStore();
  const { openFolder } = useOpenFolder();
  const { addScanFolder } = useAddScanFolder();
  const external = useExternal();
  const review = useReviewStore();
  const notesExport = useNotesExport();
  const picker = usePickerStore();
  const compare = useCompareStore();
  const worktrees = useWorktreesStore();
  const changes = useChangesStore();
  const remotes = useRemotesStore();
  const sequencer = useSequencerStore();
  const stash = useStashStore();
  const projects = useProjectsStore();
  const projectDialogs = useProjectDialogsStore();

  return {
    hasRepository: () => repo.state.kind === "ready",
    repositoryPinned: () => {
      const root = repo.repo?.root;
      const entry = root === undefined ? undefined : index.find(root);
      return entry ? entry.pinned : null;
    },
    hasScanFolders: () => index.scanRoots.length > 0,
    openFolder: async () => {
      await openFolder();
    },
    goToRepositories: () => repo.close(),
    scanFolders: () => index.startScan(),
    addScanFolder: async () => {
      await addScanFolder();
    },
    pinRepository: async (pinned) => {
      const root = repo.repo?.root;
      if (root !== undefined) await index.pin(root, pinned);
    },
    setGraphFocus: () => void shell.setLayoutMode("graph"),
    setReviewFocus: () => void shell.setLayoutMode("review"),
    toggleSidebar: () => void shell.toggleSidebar(),
    openTerminal: async () => {
      await external.openTerminal();
    },
    openEditor: async () => {
      await external.openEditor();
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
    openComparisonInReview: () => compare.openInReview(),
    showWorktrees: () => worktrees.show(),
    hasFolderView: () => settings.values.folderView !== null,
    showFolderView: async () => {
      const shown = settings.values.folderView;
      if (shown !== null) await folder.open(shown);
    },
    showChanges: () => shell.setLayoutMode("changes"),
    branchAction: (action) => picker.open({ kind: "branch-action", action }),
    network: (action) => {
      const branch = repo.currentBranch?.name;
      if (branch) remotes.ask({ kind: action, branch });
    },
    fetchAll: async () => {
      await remotes.fetch(null, false);
    },
    openRemotes: () => remotes.openSheet(),
    openStashes: () => stash.openSheet(),
    inOperation: () => sequencer.inProgress,
    sequencer: (action) => {
      if (action === "abort") sequencer.askAbort();
      else void sequencer.act("continue");
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
    newProject: () => projectDialogs.create(),
    editProject: () => {
      const active = projects.active;
      if (active) projectDialogs.edit(active.id);
    },
    showProject: async (tab) => {
      const active = projects.active;
      if (active) await projects.open(active.id, tab);
    },
    fetchProject: async () => {
      const active = projects.active;
      if (!active) return;
      await projects.open(active.id, "overview");
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

/** The Projects section: every project, opening its Overview. */
export function usePaletteProjects(): ComputedRef<PaletteRepo[]> {
  const projects = useProjectsStore();
  const { t, n } = i18n.global;
  return computed(() =>
    projects.projects.map((project) => ({
      path: String(project.id),
      name: project.name,
      context: t("project.repositories", { n: n(project.members.length) }, project.members.length),
      featured: true,
      icon: Layers,
      run: () => projects.open(project.id, "overview"),
    })),
  );
}

/**
 * The Repos section: every indexed entry, the pinned and recent ones featured while the
 * query is empty, each opening through the index store; the active project's members first,
 * in its order, while the open repository is one of them or its view shows.
 */
export function usePaletteRepos(): ComputedRef<PaletteRepo[]> {
  const index = useIndexStore();
  const format = useDiscoveryFormat();
  const projects = useProjectsStore();
  const shell = useShellStore();
  const toRepo = (entry: IndexEntry, featured: boolean): PaletteRepo => ({
    path: entry.path,
    name: entry.name,
    context: format.displayPath(entry.path),
    featured,
    icon: entry.kind === "worktree" ? ListTree : FolderGit2,
    run: () => index.open(entry.path),
  });
  return computed(() => {
    const inProject = projects.openIsMember || shell.layoutMode === "project";
    const members = inProject
      ? projects.activeMembers.flatMap((member) =>
          member.entry && !member.missing ? [member.entry] : [],
        )
      : [];
    const first = new Set(members.map((entry) => entry.path));
    const featured = [...index.pinned, ...index.recent].filter((entry) => !first.has(entry.path));
    const listed = new Set([...first, ...featured.map((entry) => entry.path)]);
    const rest = [...index.mains, ...index.worktrees].filter((entry) => !listed.has(entry.path));
    return [
      ...members.map((entry) => toRepo(entry, true)),
      ...featured.map((entry) => toRepo(entry, true)),
      ...rest.map((entry) => toRepo(entry, false)),
    ];
  });
}
