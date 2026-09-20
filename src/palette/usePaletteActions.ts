// Wires the palette commands and the Repos section to the stores and the shell helpers; the
// overlay only renders.

import { FolderGit2, ListTree } from "@lucide/vue";
import { computed, type ComputedRef } from "vue";

import { useAddScanFolder } from "@/discovery/useAddScanFolder";
import { useDiscoveryFormat } from "@/discovery/useDiscoveryFormat";
import { setLocale } from "@/i18n";
import type { IndexEntry } from "@/ipc/schemas";
import { useExternal } from "@/shell/useExternal";
import { useOpenFolder } from "@/shell/useOpenFolder";
import { useIndexStore } from "@/stores/index";
import { useRepoStore } from "@/stores/repo";
import { useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";

import type { PaletteActions } from "./commands";
import type { PaletteRepo } from "./usePalette";

export function usePaletteActions(): PaletteActions {
  const shell = useShellStore();
  const repo = useRepoStore();
  const index = useIndexStore();
  const settings = useSettingsStore();
  const { openFolder } = useOpenFolder();
  const { addScanFolder } = useAddScanFolder();
  const external = useExternal();

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
  };
}

/**
 * The Repos section: every indexed entry, the pinned and recent ones featured while the
 * query is empty, each opening through the index store.
 */
export function usePaletteRepos(): ComputedRef<PaletteRepo[]> {
  const index = useIndexStore();
  const format = useDiscoveryFormat();
  const toRepo = (entry: IndexEntry, featured: boolean): PaletteRepo => ({
    path: entry.path,
    name: entry.name,
    context: format.displayPath(entry.path),
    featured,
    icon: entry.kind === "worktree" ? ListTree : FolderGit2,
    run: () => index.open(entry.path),
  });
  return computed(() => {
    const featured = [...index.pinned, ...index.recent];
    const listed = new Set(featured.map((entry) => entry.path));
    const rest = [...index.mains, ...index.worktrees].filter((entry) => !listed.has(entry.path));
    return [
      ...featured.map((entry) => toRepo(entry, true)),
      ...rest.map((entry) => toRepo(entry, false)),
    ];
  });
}
