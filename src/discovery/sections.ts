// The rows of the home table: Pinned, Recent, one section per scan folder and one for the
// repositories opened on their own, every main repository followed by its worktrees, each
// entry listed once. Pure, so the table stays a renderer.

import { laneIndex } from "@/components/lanes";
import type { IndexEntry } from "@/ipc/schemas";
import { sameFolder } from "@/shell/format";
import type { FolderScanState, ScanState } from "@/stores/index";

export type SectionKind = "pinned" | "recent" | "folder" | "other";

export interface TableRow {
  /** Unique within the table (an entry appears once, so the path serves). */
  key: string;
  entry: IndexEntry;
  /** A worktree listed under its repository: the row draws the connector. */
  nested: boolean;
  /** The id of the section the row is listed in. */
  section: string;
}

export interface TableSection {
  /** Unique within the table: the kind, or `folder:<path>` for a scan folder's section. */
  id: string;
  kind: SectionKind;
  /** The scan folder a folder section lists; null for the others. */
  folder: string | null;
  rows: TableRow[];
  /** Main repositories in the section, shown next to its label. */
  count: number;
}

/** What the table needs from the index store. */
export interface SectionSource {
  pinned: IndexEntry[];
  recent: IndexEntry[];
  /** Every main repository in the order of the table sort. */
  all: IndexEntry[];
  /** The scan folders in their order: one section each. */
  scanRoots: string[];
  worktreesOf(path: string): IndexEntry[];
}

/**
 * Builds the sections. Pinned lists the pinned entries (a pinned worktree stays under its
 * pinned repository), Recent the last opened ones; then each scan folder lists the
 * repositories found in it and not shown above, and a last section the rest (opened on their
 * own, or found in a folder no longer scanned). A main repository is always followed by the
 * worktrees not listed yet. Empty sections are left out.
 */
export function tableSections(source: SectionSource): TableSection[] {
  const shown = new Set<string>();
  const build = (
    kind: SectionKind,
    entries: IndexEntry[],
    folder: string | null = null,
  ): TableSection => {
    const id = folder === null ? kind : `folder:${folder}`;
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
    return { id, kind, folder, rows, count };
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
  const folders = source.scanRoots.map((root) =>
    build(
      "folder",
      source.all.filter((entry) => entry.scanRoot !== null && sameFolder(entry.scanRoot, root)),
      root,
    ),
  );
  const other = build("other", source.all);
  return [pinned, recent, ...folders, other].filter((section) => section.rows.length > 0);
}

/**
 * Lane colour per branch name, by first appearance among the rows, so the same branch keeps
 * one colour across repositories and worktrees. Detached and unborn entries get lane 0 (none).
 */
/** What the running scan is doing with a folder section's folder; nothing for the others. */
export function sectionScanState(
  section: TableSection,
  scan: ScanState,
): FolderScanState | undefined {
  const folder = section.folder;
  if (scan.kind !== "scanning" || folder === null) return undefined;
  return Object.entries(scan.folders).find(([known]) => sameFolder(known, folder))?.[1];
}

/**
 * Where the skeleton rows stand, as the position of the section they follow: -1, before
 * every section, while the index loads; during a scan, under the folder it walks, else after
 * the last section before the repositories opened on their own; null when nothing loads.
 */
export function skeletonAfter(
  sections: TableSection[],
  loaded: boolean,
  scan: ScanState,
): number | null {
  if (!loaded) return -1;
  if (scan.kind !== "scanning") return null;
  const current = scan.current;
  const walked =
    current === null
      ? -1
      : sections.findIndex(
          (section) => section.folder !== null && sameFolder(section.folder, current),
        );
  if (walked >= 0) return walked;
  const other = sections.findIndex((section) => section.kind === "other");
  return (other >= 0 ? other : sections.length) - 1;
}

export function branchLanes(rows: TableRow[]): Map<string, number> {
  const lanes = new Map<string, number>();
  for (const row of rows) {
    const branch = row.entry.summary.currentBranch;
    if (branch === null || lanes.has(branch)) continue;
    lanes.set(branch, laneIndex(lanes.size + 1));
  }
  return lanes;
}
