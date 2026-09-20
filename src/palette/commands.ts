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
  inReview: () => boolean;
  toggleLayout: () => Promise<void>;
  toggleWrap: () => Promise<void>;
  toggleWhitespace: () => Promise<void>;
  moveSymbol: (step: 1 | -1) => void;
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
      id: "next-symbol",
      labelKey: "palette.commandsById.next-symbol",
      shortcutId: "next-symbol",
      enabled: () => withRepo() && actions.inReview(),
      run: () => actions.moveSymbol(1),
    },
    {
      id: "previous-symbol",
      labelKey: "palette.commandsById.previous-symbol",
      shortcutId: "previous-symbol",
      enabled: () => withRepo() && actions.inReview(),
      run: () => actions.moveSymbol(-1),
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
