// The rows of the home table: Pinned, Recent and All repositories, every main repository
// followed by its worktrees, each entry listed once. Pure, so the table stays a renderer.

import { laneIndex } from "@/components/lanes";
import type { IndexEntry } from "@/ipc/schemas";

export type SectionId = "pinned" | "recent" | "all";

export interface TableRow {
  /** Unique within the table (an entry appears once, so the path serves). */
  key: string;
  entry: IndexEntry;
  /** A worktree listed under its repository: the row draws the connector. */
  nested: boolean;
  section: SectionId;
}

export interface TableSection {
  id: SectionId;
  rows: TableRow[];
  /** Main repositories in the section, shown next to the "All repositories" label. */
  count: number;
}

/** What the table needs from the index store. */
export interface SectionSource {
  pinned: IndexEntry[];
  recent: IndexEntry[];
  /** Every main repository in the order of the table sort. */
  all: IndexEntry[];
  worktreesOf(path: string): IndexEntry[];
}

/**
 * Builds the sections. Pinned lists the pinned entries (a pinned worktree stays under its
 * pinned repository), Recent the last opened ones, All the repositories not shown above; a
 * main repository is always followed by the worktrees not listed yet. Empty sections are left
 * out.
 */
export function tableSections(source: SectionSource): TableSection[] {
  const shown = new Set<string>();
  const build = (id: SectionId, entries: IndexEntry[]): TableSection => {
    const rows: TableRow[] = [];
    let count = 0;
    for (const entry of entries) {
      if (shown.has(entry.path)) continue;
      shown.add(entry.path);
      rows.push({ key: entry.path, entry, nested: false, section: id });
      if (entry.kind !== "main") continue;
      count += 1;
      for (const worktree of source.worktreesOf(entry.path)) {
        if (shown.has(worktree.path)) continue;
        shown.add(worktree.path);
        rows.push({ key: worktree.path, entry: worktree, nested: true, section: id });
      }
    }
    return { id, rows, count };
  };
  // A pinned worktree whose repository is pinned too is listed under it, not on its own.
  const pinnedPaths = new Set(source.pinned.map((entry) => entry.path));
  const pinnedFirst = [
    ...source.pinned.filter((entry) => entry.kind === "main"),
    ...source.pinned.filter(
      (entry) =>
        entry.kind === "worktree" && !(entry.parentPath && pinnedPaths.has(entry.parentPath)),
    ),
  ];
  const pinned = build("pinned", pinnedFirst);
  const recent = build("recent", source.recent);
  const all = build("all", source.all);
  return [pinned, recent, all].filter((section) => section.rows.length > 0);
}

/**
 * Lane colour per branch name, by first appearance among the rows, so the same branch keeps
 * one colour across repositories and worktrees. Detached and unborn entries get lane 0 (none).
 */
export function branchLanes(rows: TableRow[]): Map<string, number> {
  const lanes = new Map<string, number>();
  for (const row of rows) {
    const branch = row.entry.summary.currentBranch;
    if (branch === null || lanes.has(branch)) continue;
    lanes.set(branch, laneIndex(lanes.size + 1));
  }
  return lanes;
}
