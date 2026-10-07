// The sidebar's panels in the rail's order, each with its name and its icon. Repositories shows
// while the open project holds more than one repository or worktree.

import { Cloud, FolderGit2, GitBranch, ListTree, Tag } from "@lucide/vue";
import type { Component } from "vue";

import type { SidebarSectionId } from "@/stores/settings";

export interface SidebarPanelInfo {
  id: SidebarSectionId;
  /** The i18n key of its name. */
  title: string;
  icon: Component;
}

export const SIDEBAR_PANELS: readonly SidebarPanelInfo[] = [
  { id: "repos", title: "sidebar.repositories", icon: FolderGit2 },
  { id: "local", title: "sidebar.branches", icon: GitBranch },
  { id: "remote", title: "sidebar.remoteBranches", icon: Cloud },
  { id: "tags", title: "sidebar.tags", icon: Tag },
  { id: "worktrees", title: "sidebar.worktrees", icon: ListTree },
];

/** The i18n key of a panel's name. */
export function panelTitle(id: SidebarSectionId): string {
  return SIDEBAR_PANELS.find((panel) => panel.id === id)?.title ?? "sidebar.branches";
}
