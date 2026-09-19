// The commands the palette offers: every shortcut binding with an action, plus the
// few actions without a key. Labels are i18n keys (`palette.commands.<id>`); the shortcut id
// gives the `Kbd` hint. Repos, branches and files are not listed.

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
  openFolder: () => Promise<void>;
  closeRepository: () => Promise<void>;
  setGraphFocus: () => void;
  setReviewFocus: () => void;
  toggleSidebar: () => void;
  openTerminal: () => Promise<void>;
  openEditor: () => Promise<void>;
  setLocale: (locale: "en" | "es") => Promise<void>;
}

export function paletteCommands(actions: PaletteActions): PaletteCommand[] {
  const withRepo = () => actions.hasRepository();
  const always = () => true;
  return [
    {
      id: "open-folder",
      labelKey: "palette.commands.open-folder",
      enabled: always,
      run: actions.openFolder,
    },
    {
      id: "graph-focus",
      labelKey: "palette.commands.graph-focus",
      shortcutId: "graph-focus",
      enabled: always,
      run: actions.setGraphFocus,
    },
    {
      id: "review-focus",
      labelKey: "palette.commands.review-focus",
      shortcutId: "review-focus",
      enabled: always,
      run: actions.setReviewFocus,
    },
    {
      id: "toggle-sidebar",
      labelKey: "palette.commands.toggle-sidebar",
      shortcutId: "toggle-sidebar",
      enabled: always,
      run: actions.toggleSidebar,
    },
    {
      id: "open-terminal",
      labelKey: "palette.commands.open-terminal",
      shortcutId: "open-terminal",
      enabled: withRepo,
      run: actions.openTerminal,
    },
    {
      id: "open-editor",
      labelKey: "palette.commands.open-editor",
      shortcutId: "open-editor",
      enabled: withRepo,
      run: actions.openEditor,
    },
    {
      id: "close-repository",
      labelKey: "palette.commands.close-repository",
      enabled: withRepo,
      run: actions.closeRepository,
    },
    {
      id: "locale-en",
      labelKey: "palette.commands.locale-en",
      enabled: always,
      run: () => actions.setLocale("en"),
    },
    {
      id: "locale-es",
      labelKey: "palette.commands.locale-es",
      enabled: always,
      run: () => actions.setLocale("es"),
    },
  ];
}
