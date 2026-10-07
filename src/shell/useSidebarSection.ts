// The rows of one sidebar panel: the open project's repositories, the local branches, the remote
// branches, the tags or the worktrees, under the panel's filter, and how many the section holds
// without it. Only the panel's own section is computed: the others stay unread.

import { computed, type ComputedRef, type Ref } from "vue";
import { useI18n } from "vue-i18n";

import type { Ref as GitRef } from "@/ipc/schemas";
import { matchesQuery } from "@/palette/usePalette";
import { useProjectsStore } from "@/stores/projects";
import { useRepoStore } from "@/stores/repo";
import { useSettingsStore } from "@/stores/settings";
import type { SidebarSectionId } from "@/stores/shell";

import { branchLanes } from "./branchLanes";
import { sortRefs } from "./branchOrder";
import { baseName, sameFolder } from "./format";

export interface RepoRow {
  path: string;
  name: string;
  branch: string;
  worktree: boolean;
  nested: boolean;
  missing: boolean;
}

export interface BranchRow {
  ref: GitRef;
  lane: number;
}

export interface WorktreeRow {
  key: string;
  name: string;
  branch: string;
  missing: boolean;
  lane: number;
}

export interface SidebarRows {
  repos: RepoRow[];
  local: BranchRow[];
  remote: BranchRow[];
  tags: BranchRow[];
  worktrees: WorktreeRow[];
}

/** The panel's rows under the filter (the other sections' empty), and the section's total. */
export interface SidebarSection {
  rows: ComputedRef<SidebarRows>;
  total: ComputedRef<number>;
}

const noRows = (): SidebarRows => ({ repos: [], local: [], remote: [], tags: [], worktrees: [] });

export function useSidebarSection(id: SidebarSectionId, filter: Ref<string>): SidebarSection {
  const { t } = useI18n();
  const repo = useRepoStore();
  const projects = useProjectsStore();
  const settings = useSettingsStore();

  const allRepos = computed<RepoRow[]>(() => {
    const filtering = filter.value.trim() !== "";
    const failing = repo.state.kind === "error" ? repo.state.path : null;
    const list: RepoRow[] = projects.activeMembers.map((member) => {
      const summary = member.entry?.summary;
      return {
        path: member.path,
        name: member.name,
        branch: summary?.detached ? t("statusBar.detached") : (summary?.currentBranch ?? ""),
        worktree: member.entry?.kind === "worktree",
        nested: member.nested && !filtering,
        missing: member.missing || (failing !== null && sameFolder(failing, member.path)),
      };
    });
    // A repository the project shows without holding it is listed first.
    const current = projects.shownPath;
    if (current !== null && !list.some((row) => sameFolder(row.path, current))) {
      list.unshift({
        path: current,
        name: baseName(current),
        branch: repo.repo?.currentBranch ?? "",
        worktree: repo.repo?.isLinkedWorktree ?? false,
        nested: false,
        missing: repo.state.kind === "error",
      });
    }
    return list;
  });

  const lanes = computed(() => branchLanes(repo.refs));

  const refsOf = (kind: GitRef["kind"]) =>
    computed<BranchRow[]>(() =>
      sortRefs(
        repo.refs.filter((ref) => ref.kind === kind),
        settings.values.branchSort,
      ).map((ref) => ({ ref, lane: lanes.value.get(ref.fullName) ?? 0 })),
    );
  const allLocal = refsOf("local-branch");
  const allRemote = refsOf("remote-branch");
  const allTags = refsOf("tag");

  const allWorktrees = computed<WorktreeRow[]>(() =>
    repo.worktrees.map((worktree) => ({
      key: worktree.path,
      name: baseName(worktree.path),
      branch: worktree.branch ?? "",
      missing: worktree.prunable,
      lane: worktree.branch
        ? (lanes.value.get(worktree.branch) ??
          lanes.value.get(`refs/heads/${worktree.branch}`) ??
          0)
        : 0,
    })),
  );

  const rows = computed<SidebarRows>(() => {
    const query = filter.value;
    const byRef = (row: BranchRow) => matchesQuery(row.ref.name, query);
    const byName = (row: { name: string; branch: string }) =>
      matchesQuery(`${row.name} ${row.branch}`, query);
    switch (id) {
      case "repos":
        return { ...noRows(), repos: allRepos.value.filter(byName) };
      case "local":
        return { ...noRows(), local: allLocal.value.filter(byRef) };
      case "remote":
        return { ...noRows(), remote: allRemote.value.filter(byRef) };
      case "tags":
        return { ...noRows(), tags: allTags.value.filter(byRef) };
      case "worktrees":
        return { ...noRows(), worktrees: allWorktrees.value.filter(byName) };
    }
  });

  const total = computed(() => {
    switch (id) {
      case "repos":
        return allRepos.value.length;
      case "local":
        return allLocal.value.length;
      case "remote":
        return allRemote.value.length;
      case "tags":
        return allTags.value.length;
      case "worktrees":
        return allWorktrees.value.length;
    }
  });

  return { rows, total };
}
