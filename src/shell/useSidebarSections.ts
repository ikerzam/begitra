// The sections of the sidebar and their rows: the open project's repositories (while it holds
// more than one), the local branches, the remote branches, the tags and the worktrees, each
// filtered by the sidebar's one filter. The lists draw the rows; the headers count them from here,
// so a folded section, whose list is not drawn, still counts.

import { computed, type ComputedRef, type Ref } from "vue";
import { useI18n } from "vue-i18n";

import type { Ref as GitRef } from "@/ipc/schemas";
import { matchesQuery } from "@/palette/usePalette";
import { useProjectsStore } from "@/stores/projects";
import { useRepoStore } from "@/stores/repo";
import { useSettingsStore, type SidebarSectionId } from "@/stores/settings";

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

/** Each section's rows under the filter, and how many it holds without it. */
export interface SidebarSections {
  rows: ComputedRef<SidebarRows>;
  totals: ComputedRef<Record<SidebarSectionId, number>>;
  /** The sections the sidebar shows, in order. */
  shown: ComputedRef<SidebarSectionId[]>;
}

export function useSidebarSections(filter: Ref<string>): SidebarSections {
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
    return {
      repos: allRepos.value.filter((row) => matchesQuery(`${row.name} ${row.branch}`, query)),
      local: allLocal.value.filter(byRef),
      remote: allRemote.value.filter(byRef),
      tags: allTags.value.filter(byRef),
      worktrees: allWorktrees.value.filter((row) =>
        matchesQuery(`${row.name} ${row.branch}`, query),
      ),
    };
  });

  const totals = computed(() => ({
    repos: allRepos.value.length,
    local: allLocal.value.length,
    remote: allRemote.value.length,
    tags: allTags.value.length,
    worktrees: allWorktrees.value.length,
  }));

  const shown = computed<SidebarSectionId[]>(() => {
    const ids: SidebarSectionId[] = [];
    if (projects.activeMembers.length > 1) ids.push("repos");
    ids.push("local");
    if (totals.value.remote > 0) ids.push("remote");
    if (totals.value.tags > 0) ids.push("tags");
    ids.push("worktrees");
    return ids;
  });

  return { rows, totals, shown };
}
