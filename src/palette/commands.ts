// The commands the palette offers: every shortcut binding with an action, plus the actions
// without a key (open and scan folders, pin the project, go to projects, language). Labels are
// i18n keys (`palette.commandsById.<id>`); the shortcut id gives the `Kbd` hint. The Projects
// and Repos sections are fed separately (see `usePalette`).

export interface PaletteCommand {
  /** Stable id; also the key of its label and, when bound, the shortcut id. */
  id: string;
  /** i18n key of the label. */
  labelKey: string;
  /** Shortcut binding id, when the command has one. */
  shortcutId?: string;
  /** Whether the command can run right now. */
  enabled: () => boolean;
  run: () => void | Promise<void>;
}

/** Actions the shell exposes to the palette; the shell wires them to stores. */
export interface PaletteActions {
  hasRepository: () => boolean;
  /** Whether the sidebar's rail shows: a project or a repository is open. */
  hasSidebar: () => boolean;
  /** Whether the open project is pinned; null without one. */
  projectPinned: () => boolean | null;
  /** Whether some folder project exists, whose folder "Scan folders" walks. */
  hasFolderProjects: () => boolean;
  openFolder: () => Promise<void>;
  goToProjects: () => Promise<void>;
  scanFolders: () => void;
  /** "Add folder…": the folder's project, made and scanned. */
  addFolder: () => Promise<void>;
  pinProject: (pinned: boolean) => Promise<void>;
  setGraphFocus: () => void;
  setReviewFocus: () => void;
  toggleSidebar: () => void;
  openTerminal: () => Promise<void>;
  openEditor: () => Promise<void>;
  setLocale: (locale: "en" | "es") => Promise<void>;
  /** Opens the picker of "Diff from…". */
  diffFrom: () => void;
  reviewWorktree: () => Promise<void>;
  reviewIndex: () => Promise<void>;
  reviewSelectedCommit: () => Promise<void>;
  hasSelectedCommit: () => boolean;
  /** Copies the review notes of the current target as Markdown. */
  copyReviewNotes: () => Promise<void>;
  hasReviewNotes: () => boolean;
  inReview: () => boolean;
  toggleLayout: () => Promise<void>;
  toggleWrap: () => Promise<void>;
  toggleWhitespace: () => Promise<void>;
  toggleWholeFile: () => Promise<void>;
  /** Runs the handler a review-scope key would run (hunks, files, symbols, mark reviewed). */
  runShortcut: (id: string) => void;
  /** Whether a screen has attached a handler to the shortcut `id` (a file shown for ⇧⌘E). */
  shortcutActive: (id: string) => boolean;
  toggleOverview: () => void;
  toggleFilter: (key: "hideGenerated" | "hideLockfiles" | "hideTests") => void;
  /** Opens the picker of "Compare with…" for the selected commit or the current branch. */
  compareWith: () => void;
  inComparison: () => boolean;
  swapComparison: () => void;
  /** Whether graph focus shows, with a repository open. */
  inGraph: () => boolean;
  /** Go to HEAD in the graph. */
  goToHead: () => void;
  /** Whether the open project has a comparison's tab beside its own. */
  hasTabs: () => boolean;
  nextTab: () => void;
  previousTab: () => void;
  /** Closes the comparison's tab shown. */
  closeTab: () => void;
  openComparisonInReview: () => Promise<void>;
  showWorktrees: () => Promise<void>;
  /** Opens the Changes: the changes screen, or the folder view of a project of several. */
  showChanges: () => Promise<void>;
  inChanges: () => boolean;
  /** "Stage all", "Unstage all" and "Discard all…" of the changes screen. */
  changesAll: (action: "stage" | "unstage" | "discard") => void;
  /** Opens the picker for a branch action on the chosen ref. */
  branchAction: (action: "checkout" | "merge" | "rebase" | "create") => void;
  /** "Push…" and "Pull…" for the current branch: the dialogs. */
  network: (action: "push" | "pull") => void;
  /** Fetch, Pull and Push as the graph's buttons do, a toast saying why when they cannot. */
  sync: (action: "fetch" | "pull" | "push") => void;
  /** Moves HEAD back from its commit, the changes kept staged. */
  undoLastCommit: () => void;
  /** Whether the last undo can be redone in the open repository. */
  canRedoUndone: () => boolean;
  /** Moves HEAD back to the commit the last undo took it from. */
  redoUndoneCommit: () => void;
  /** Whether the last discard's toast stands with its Undo (or its Try again). */
  canUndoDiscard: () => boolean;
  /** The Undo of the last discard's toast. */
  undoDiscard: () => void;
  /** Opens the dialog of the branches that can go against the main branch. */
  cleanUpBranches: () => void;
  openRemotes: () => Promise<void>;
  openStashes: () => void;
  /** Whether an operation stopped on conflicts is in progress. */
  inOperation: () => boolean;
  sequencer: (action: "continue" | "abort") => void;
  openSettings: () => Promise<void>;
  addWorktree: () => void;
  /** Whether some worktree entry can be pruned (its folder is gone). */
  hasPrunableWorktrees: () => boolean;
  pruneWorktrees: () => void;
  /** Whether a project is open. */
  hasActiveProject: () => boolean;
  /** Whether the open project holds more than one repository. */
  hasSeveralRepositories: () => boolean;
  newProject: () => void;
  editProject: () => void;
  showOverview: () => Promise<void>;
  /** Fetches every member of the open project from its Overview. */
  fetchProject: () => Promise<void>;
  /** Shows the member after (1) or before (-1) the shown one in the open project. */
  projectNeighbour: (step: 1 | -1) => Promise<void>;
}

export function paletteCommands(actions: PaletteActions): PaletteCommand[] {
  const withRepo = () => actions.hasRepository();
  const always = () => true;
  const several = () => actions.hasSeveralRepositories();
  return [
    {
      id: "open-folder",
      labelKey: "palette.commandsById.open-folder",
      enabled: always,
      run: actions.openFolder,
    },
    {
      id: "graph-focus",
      labelKey: "palette.commandsById.graph-focus",
      shortcutId: "graph-focus",
      enabled: always,
      run: actions.setGraphFocus,
    },
    {
      id: "review-focus",
      labelKey: "palette.commandsById.review-focus",
      shortcutId: "review-focus",
      enabled: always,
      run: actions.setReviewFocus,
    },
    {
      id: "changes-focus",
      labelKey: "palette.commandsById.changes-focus",
      shortcutId: "changes-focus",
      enabled: () => withRepo() || several(),
      run: actions.showChanges,
    },
    {
      id: "toggle-sidebar",
      labelKey: "palette.commandsById.toggle-sidebar",
      shortcutId: "toggle-sidebar",
      enabled: actions.hasSidebar,
      run: actions.toggleSidebar,
    },
    ...["zoom-in", "zoom-out", "zoom-reset"].map((id) => ({
      id,
      labelKey: `palette.commandsById.${id}`,
      shortcutId: id,
      enabled: always,
      run: () => actions.runShortcut(id),
    })),
    {
      id: "open-terminal",
      labelKey: "palette.commandsById.open-terminal",
      shortcutId: "open-terminal",
      enabled: withRepo,
      run: actions.openTerminal,
    },
    {
      id: "open-editor",
      labelKey: "palette.commandsById.open-editor",
      shortcutId: "open-editor",
      enabled: withRepo,
      run: actions.openEditor,
    },
    {
      id: "open-file-editor",
      labelKey: "palette.commandsById.open-file-editor",
      shortcutId: "open-file-editor",
      enabled: () => actions.shortcutActive("open-file-editor"),
      run: () => actions.runShortcut("open-file-editor"),
    },
    {
      id: "pin-project",
      labelKey: "palette.commandsById.pin-project",
      enabled: () => actions.projectPinned() === false,
      run: () => actions.pinProject(true),
    },
    {
      id: "unpin-project",
      labelKey: "palette.commandsById.unpin-project",
      enabled: () => actions.projectPinned() === true,
      run: () => actions.pinProject(false),
    },
    {
      id: "go-to-projects",
      labelKey: "palette.commandsById.go-to-projects",
      enabled: actions.hasActiveProject,
      run: actions.goToProjects,
    },
    {
      id: "scan-folders",
      labelKey: "palette.commandsById.scan-folders",
      enabled: () => actions.hasFolderProjects(),
      run: actions.scanFolders,
    },
    {
      id: "add-folder",
      labelKey: "palette.commandsById.add-folder",
      enabled: always,
      run: actions.addFolder,
    },
    {
      id: "diff-from",
      labelKey: "palette.commandsById.diff-from",
      shortcutId: "diff-from",
      enabled: withRepo,
      run: actions.diffFrom,
    },
    {
      id: "review-worktree",
      labelKey: "palette.commandsById.review-worktree",
      enabled: withRepo,
      run: actions.reviewWorktree,
    },
    {
      id: "review-index",
      labelKey: "palette.commandsById.review-index",
      enabled: withRepo,
      run: actions.reviewIndex,
    },
    {
      id: "review-selected-commit",
      labelKey: "palette.commandsById.review-selected-commit",
      enabled: () => withRepo() && actions.hasSelectedCommit(),
      run: actions.reviewSelectedCommit,
    },
    {
      id: "copy-review-notes",
      labelKey: "palette.commandsById.copy-review-notes",
      enabled: () => withRepo() && actions.hasReviewNotes(),
      run: actions.copyReviewNotes,
    },
    {
      id: "toggle-layout",
      labelKey: "palette.commandsById.toggle-layout",
      enabled: withRepo,
      run: actions.toggleLayout,
    },
    {
      id: "toggle-wrap",
      labelKey: "palette.commandsById.toggle-wrap",
      enabled: withRepo,
      run: actions.toggleWrap,
    },
    {
      id: "toggle-whitespace",
      labelKey: "palette.commandsById.toggle-whitespace",
      enabled: withRepo,
      run: actions.toggleWhitespace,
    },
    {
      id: "toggle-whole-file",
      labelKey: "palette.commandsById.toggle-whole-file",
      shortcutId: "toggle-whole-file",
      enabled: withRepo,
      run: actions.toggleWholeFile,
    },
    ...[
      "next-hunk",
      "previous-hunk",
      "next-symbol",
      "previous-symbol",
      "next-file",
      "previous-file",
      "mark-reviewed",
    ].map((id) => ({
      id,
      labelKey: `palette.commandsById.${id}`,
      shortcutId: id,
      enabled: () => withRepo() && actions.inReview(),
      run: () => actions.runShortcut(id),
    })),
    {
      id: "compare-with",
      labelKey: "palette.commandsById.compare-with",
      shortcutId: "compare-with",
      enabled: withRepo,
      run: actions.compareWith,
    },
    {
      id: "swap-comparison",
      labelKey: "palette.commandsById.swap-comparison",
      enabled: () => withRepo() && actions.inComparison(),
      run: actions.swapComparison,
    },
    {
      id: "compare-open-review",
      labelKey: "palette.commandsById.compare-open-review",
      enabled: () => withRepo() && actions.inComparison(),
      run: actions.openComparisonInReview,
    },
    {
      id: "go-to-head",
      labelKey: "palette.commandsById.go-to-head",
      shortcutId: "go-to-head",
      enabled: actions.inGraph,
      run: actions.goToHead,
    },
    {
      id: "next-tab",
      labelKey: "palette.commandsById.next-tab",
      shortcutId: "next-tab",
      enabled: actions.hasTabs,
      run: actions.nextTab,
    },
    {
      id: "previous-tab",
      labelKey: "palette.commandsById.previous-tab",
      shortcutId: "previous-tab",
      enabled: actions.hasTabs,
      run: actions.previousTab,
    },
    {
      id: "close-tab",
      labelKey: "palette.commandsById.close-tab",
      shortcutId: "close-tab",
      enabled: actions.inComparison,
      run: actions.closeTab,
    },
    {
      id: "settings",
      labelKey: "palette.commandsById.settings",
      shortcutId: "settings",
      enabled: always,
      run: actions.openSettings,
    },
    {
      id: "show-worktrees",
      labelKey: "palette.commandsById.show-worktrees",
      enabled: withRepo,
      run: actions.showWorktrees,
    },
    {
      id: "add-worktree",
      labelKey: "palette.commandsById.add-worktree",
      shortcutId: "add-worktree",
      enabled: withRepo,
      run: actions.addWorktree,
    },
    {
      id: "prune-worktrees",
      labelKey: "palette.commandsById.prune-worktrees",
      enabled: () => withRepo() && actions.hasPrunableWorktrees(),
      run: actions.pruneWorktrees,
    },
    {
      id: "new-project",
      labelKey: "palette.commandsById.new-project",
      enabled: always,
      run: actions.newProject,
    },
    {
      id: "edit-project",
      labelKey: "palette.commandsById.edit-project",
      enabled: actions.hasActiveProject,
      run: actions.editProject,
    },
    {
      id: "show-project-overview",
      labelKey: "palette.commandsById.show-project-overview",
      shortcutId: "overview-focus",
      enabled: several,
      run: actions.showOverview,
    },
    {
      id: "fetch-project",
      labelKey: "palette.commandsById.fetch-project",
      enabled: several,
      run: actions.fetchProject,
    },
    {
      id: "next-project-repo",
      labelKey: "palette.commandsById.next-project-repo",
      shortcutId: "next-project-repo",
      enabled: several,
      run: () => actions.projectNeighbour(1),
    },
    {
      id: "previous-project-repo",
      labelKey: "palette.commandsById.previous-project-repo",
      shortcutId: "previous-project-repo",
      enabled: several,
      run: () => actions.projectNeighbour(-1),
    },
    ...["stage-file", "unstage-file", "discard-file", "commit", "commit-push"].map((id) => ({
      id,
      labelKey: `palette.commandsById.${id}`,
      shortcutId: id,
      enabled: () => withRepo() && actions.inChanges(),
      run: () => actions.runShortcut(id),
    })),
    ...(["stage", "unstage", "discard"] as const).map((action) => ({
      id: `${action}-all`,
      labelKey: `palette.commandsById.${action}-all`,
      enabled: () => withRepo() && actions.inChanges(),
      run: () => actions.changesAll(action),
    })),
    {
      id: "checkout",
      labelKey: "palette.commandsById.checkout",
      enabled: withRepo,
      run: () => actions.branchAction("checkout"),
    },
    {
      id: "create-branch",
      labelKey: "palette.commandsById.create-branch",
      enabled: withRepo,
      run: () => actions.branchAction("create"),
    },
    {
      id: "merge-into",
      labelKey: "palette.commandsById.merge-into",
      enabled: withRepo,
      run: () => actions.branchAction("merge"),
    },
    {
      id: "rebase-onto",
      labelKey: "palette.commandsById.rebase-onto",
      enabled: withRepo,
      run: () => actions.branchAction("rebase"),
    },
    {
      id: "undo-last-commit",
      labelKey: "palette.commandsById.undo-last-commit",
      enabled: withRepo,
      run: actions.undoLastCommit,
    },
    {
      id: "redo-undone-commit",
      labelKey: "palette.commandsById.redo-undone-commit",
      enabled: () => withRepo() && actions.canRedoUndone(),
      run: actions.redoUndoneCommit,
    },
    {
      id: "undo-discard",
      labelKey: "palette.commandsById.undo-discard",
      enabled: () => actions.canUndoDiscard(),
      run: actions.undoDiscard,
    },
    {
      id: "push-now",
      labelKey: "palette.commandsById.push-now",
      enabled: withRepo,
      run: () => actions.sync("push"),
    },
    {
      id: "push",
      labelKey: "palette.commandsById.push",
      shortcutId: "push",
      enabled: withRepo,
      run: () => actions.network("push"),
    },
    {
      id: "pull-now",
      labelKey: "palette.commandsById.pull-now",
      shortcutId: "pull",
      enabled: withRepo,
      run: () => actions.sync("pull"),
    },
    {
      id: "pull",
      labelKey: "palette.commandsById.pull",
      enabled: withRepo,
      run: () => actions.network("pull"),
    },
    {
      id: "fetch-all",
      labelKey: "palette.commandsById.fetch-all",
      shortcutId: "fetch",
      enabled: withRepo,
      run: () => actions.sync("fetch"),
    },
    {
      id: "clean-up-branches",
      labelKey: "palette.commandsById.clean-up-branches",
      enabled: withRepo,
      run: actions.cleanUpBranches,
    },
    {
      id: "remotes",
      labelKey: "palette.commandsById.remotes",
      enabled: withRepo,
      run: actions.openRemotes,
    },
    {
      id: "stashes",
      labelKey: "palette.commandsById.stashes",
      enabled: withRepo,
      run: actions.openStashes,
    },
    {
      id: "stash-changes",
      labelKey: "palette.commandsById.stash-changes",
      enabled: withRepo,
      run: actions.openStashes,
    },
    {
      id: "continue-operation",
      labelKey: "palette.commandsById.continue-operation",
      enabled: () => withRepo() && actions.inOperation(),
      run: () => actions.sequencer("continue"),
    },
    {
      id: "abort-operation",
      labelKey: "palette.commandsById.abort-operation",
      enabled: () => withRepo() && actions.inOperation(),
      run: () => actions.sequencer("abort"),
    },
    {
      id: "toggle-overview",
      labelKey: "palette.commandsById.toggle-overview",
      enabled: () => withRepo() && actions.inReview(),
      run: actions.toggleOverview,
    },
    {
      id: "toggle-hide-generated",
      labelKey: "palette.commandsById.toggle-hide-generated",
      enabled: withRepo,
      run: () => actions.toggleFilter("hideGenerated"),
    },
    {
      id: "toggle-hide-lockfiles",
      labelKey: "palette.commandsById.toggle-hide-lockfiles",
      enabled: withRepo,
      run: () => actions.toggleFilter("hideLockfiles"),
    },
    {
      id: "toggle-hide-tests",
      labelKey: "palette.commandsById.toggle-hide-tests",
      enabled: withRepo,
      run: () => actions.toggleFilter("hideTests"),
    },
    {
      id: "locale-en",
      labelKey: "palette.commandsById.locale-en",
      enabled: always,
      run: () => actions.setLocale("en"),
    },
    {
      id: "locale-es",
      labelKey: "palette.commandsById.locale-es",
      enabled: always,
      run: () => actions.setLocale("es"),
    },
  ];
}
