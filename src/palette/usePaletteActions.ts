// Wires the palette commands to the stores and the shell helpers; the overlay only renders.

import { setLocale } from "@/i18n";
import { useExternal } from "@/shell/useExternal";
import { useOpenFolder } from "@/shell/useOpenFolder";
import { useRepoStore } from "@/stores/repo";
import { useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";

import type { PaletteActions } from "./commands";

export function usePaletteActions(): PaletteActions {
  const shell = useShellStore();
  const repo = useRepoStore();
  const settings = useSettingsStore();
  const { openFolder } = useOpenFolder();
  const external = useExternal();

  return {
    hasRepository: () => repo.state.kind === "ready",
    openFolder: async () => {
      await openFolder();
    },
    closeRepository: () => repo.close(),
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
  };
}
