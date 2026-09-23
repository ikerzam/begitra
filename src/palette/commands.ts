// The commands the palette offers: every shortcut binding with an action, plus the actions
// without a key (open and scan folders, pin, go to repositories, language). Labels are i18n
// keys (`palette.commandsById.<id>`); the shortcut id gives the `Kbd` hint. The Repos section
// is fed separately (see `usePalette`); branches and files are not listed.

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
  /** Whether the open repository is pinned; null when it is not in the index. */
  repositoryPinned: () => boolean | null;
  hasScanFolders: () => boolean;
  openFolder: () => Promise<void>;
  goToRepositories: () => Promise<void>;
  scanFolders: () => void;
  addScanFolder: () => Promise<void>;
  pinRepository: (pinned: boolean) => Promise<void>;
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
  /** Runs the handler a review-scope key would run (hunks, files, symbols, mark reviewed). */
  runShortcut: (id: string) => void;
  toggleOverview: () => void;
  toggleFilter: (key: "hideGenerated" | "hideLockfiles" | "hideTests") => void;
  /** Opens the picker of "Compare with…" for the selected commit or the current branch. */
  compareWith: () => void;
  inComparison: () => boolean;
  swapComparison: () => Promise<void>;
  openComparisonInReview: () => Promise<void>;
  showWorktrees: () => Promise<void>;
  /** Opens the changes screen. */
  showChanges: () => Promise<void>;
  inChanges: () => boolean;
  /** "Stage all", "Unstage all" and "Discard all…" of the changes screen. */
  changesAll: (action: "stage" | "unstage" | "discard") => void;
  /** Opens the picker for a branch action on the chosen ref. */
  branchAction: (action: "checkout" | "merge" | "rebase" | "create") => void;
  /** "Push…" and "Pull…" for the current branch. */
  network: (action: "push" | "pull") => void;
  fetchAll: () => Promise<void>;
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
}

export function paletteCommands(actions: PaletteActions): PaletteCommand[] {
  const withRepo = () => actions.hasRepository();
  const always = () => true;
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
      enabled: withRepo,
      run: actions.showChanges,
    },
    {
      id: "toggle-sidebar",
      labelKey: "palette.commandsById.toggle-sidebar",
      shortcutId: "toggle-sidebar",
      enabled: always,
      run: actions.toggleSidebar,
    },
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
      id: "pin-repository",
      labelKey: "palette.commandsById.pin-repository",
      enabled: () => withRepo() && actions.repositoryPinned() === false,
      run: () => actions.pinRepository(true),
    },
    {
      id: "unpin-repository",
      labelKey: "palette.commandsById.unpin-repository",
      enabled: () => withRepo() && actions.repositoryPinned() === true,
      run: () => actions.pinRepository(false),
    },
    {
      id: "go-to-repositories",
      labelKey: "palette.commandsById.go-to-repositories",
      enabled: withRepo,
      run: actions.goToRepositories,
    },
    {
      id: "scan-folders",
      labelKey: "palette.commandsById.scan-folders",
      enabled: () => actions.hasScanFolders(),
      run: actions.scanFolders,
    },
    {
      id: "add-scan-folder",
      labelKey: "palette.commandsById.add-scan-folder",
      enabled: always,
      run: actions.addScanFolder,
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
    ...["stage-file", "unstage-file", "discard-file", "commit"].map((id) => ({
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
      id: "push",
      labelKey: "palette.commandsById.push",
      shortcutId: "push",
      enabled: withRepo,
      run: () => actions.network("push"),
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
      enabled: withRepo,
      run: actions.fetchAll,
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
