// The rows of the picker from the open repository: Branches (local first, the current one
// marked, ahead/behind or the worktree folder as context), Tags (the short hash as context),
// Worktrees (the branch as context), Recent commits (the loaded commits, short hash and
// subject, relative date); a query shaped like `A..B` or `A...B` yields the Range group with
// its endpoints instead. Pure over its inputs so it is unit-tested on data.

import type { Component } from "vue";

import type { CommitNode, Ref as GitRef, Worktree } from "@/ipc/schemas";
import { matchesQuery } from "@/palette/usePalette";
import { shortHash } from "@/shell/format";
import type { PickerChoice } from "@/stores/picker";

export type PickerSection = "range" | "endpoints" | "branches" | "tags" | "worktrees" | "commits";

export interface PickerRow {
  key: string;
  section: PickerSection;
  label: string;
  /** Muted text at the right: ahead/behind, a folder, a hash, a date. */
  context: string;
  /** Lane of the branch (0 for none), for the lane-coloured icon. */
  lane: number;
  icon?: Component;
  choice: PickerChoice;
  /** What an endpoint row names, for its icon; other sections know theirs. */
  kind?: "branch" | "tag" | "commit";
}

export interface RangeQuery {
  from: string;
  to: string;
  threeDot: boolean;
}

/** `A..B` or `A...B` typed in the input; null for anything else. */
export function parseRange(query: string): RangeQuery | null {
  const match = /^\s*([^\s.][^\s]*?)(\.{2,3})([^\s.][^\s]*)\s*$/.exec(query);
  if (!match) return null;
  const from = match[1]!;
  const to = match[3]!;
  // Four dots or more leave a dot on an endpoint: not a range.
  if (from.endsWith(".") || to.startsWith(".")) return null;
  return { from, to, threeDot: match[2] === "..." };
}

/** The same range with the other dots. */
export function toggleDots(query: string): string {
  const range = parseRange(query);
  if (!range) return query;
  return `${range.from}${range.threeDot ? ".." : "..."}${range.to}`;
}

export interface PickerInputs {
  query: string;
  refs: GitRef[];
  worktrees: Worktree[];
  commits: CommitNode[];
  lanes: Map<string, number>;
  /** Formats a relative date. */
  ago: (unixSeconds: number) => string;
  /** Translated context words. */
  words: { current: string; worktree: string };
  /** Most recent commits listed. Default 20. */
  recentLimit?: number;
  /** Whether a typed `A..B` yields the Range group (not in compare mode). Default true. */
  ranges?: boolean;
}

/** Rows for the query, grouped as branches, tags, worktrees and recent commits. */
export function pickerRows(inputs: PickerInputs): PickerRow[] {
  const range = inputs.ranges === false ? null : parseRange(inputs.query);
  if (range) return rangeRows(range, inputs);
  const query = inputs.query.trim();
  const rows: PickerRow[] = [];
  const branches = inputs.refs.filter(
    (ref) => ref.kind === "local-branch" || ref.kind === "remote-branch",
  );
  for (const ref of branches) {
    if (!matchesQuery(ref.name, query)) continue;
    const parts: string[] = [];
    if (ref.isCurrent) parts.push(inputs.words.current);
    if (ref.worktree && !ref.isCurrent) parts.push(`${inputs.words.worktree} ${ref.worktree}`);
    else if (ref.upstream && ref.ahead !== null && ref.behind !== null) {
      parts.push(`↑${ref.ahead} ↓${ref.behind}`);
    }
    rows.push({
      key: `branch:${ref.fullName}`,
      section: "branches",
      label: ref.name,
      context: parts.join(" "),
      lane: inputs.lanes.get(ref.fullName) ?? 0,
      choice: { kind: "revision", rev: ref.fullName, label: ref.name },
    });
  }
  for (const ref of inputs.refs.filter((r) => r.kind === "tag")) {
    if (!matchesQuery(ref.name, query)) continue;
    // The relative date of the tagged commit when the history holds it, else its hash.
    const tagged = inputs.commits.find((c) => c.hash === ref.target);
    rows.push({
      key: `tag:${ref.fullName}`,
      section: "tags",
      label: ref.name,
      context: tagged ? inputs.ago(tagged.author.time) : shortHash(ref.target),
      lane: 0,
      choice: { kind: "revision", rev: ref.fullName, label: ref.name },
    });
  }
  for (const worktree of inputs.worktrees.filter((w) => !w.isMain)) {
    const label = worktree.path;
    if (!matchesQuery(`${label} ${worktree.branch ?? ""}`, query)) continue;
    rows.push({
      key: `worktree:${worktree.path}`,
      section: "worktrees",
      label,
      context: worktree.branch ?? "",
      lane: worktree.branch ? (inputs.lanes.get(`refs/heads/${worktree.branch}`) ?? 0) : 0,
      choice: { kind: "worktree", path: worktree.path, branch: worktree.branch },
    });
  }
  for (const commit of inputs.commits.slice(0, inputs.recentLimit ?? 20)) {
    const label = `${shortHash(commit.hash)}  ${commit.subject}`;
    if (!matchesQuery(label, query)) continue;
    rows.push({
      key: `commit:${commit.hash}`,
      section: "commits",
      label,
      context: inputs.ago(commit.author.time),
      lane: 0,
      choice: { kind: "revision", rev: commit.hash, label: shortHash(commit.hash) },
    });
  }
  return rows;
}

function rangeRows(range: RangeQuery, inputs: PickerInputs): PickerRow[] {
  const dots = range.threeDot ? "..." : "..";
  const rows: PickerRow[] = [
    {
      key: "range",
      section: "range",
      label: `${range.from}${dots}${range.to}`,
      context: "",
      lane: 0,
      choice: { kind: "range", from: range.from, to: range.to, threeDot: range.threeDot },
    },
  ];
  for (const name of [range.from, range.to]) {
    const ref = inputs.refs.find((r) => r.name === name || r.fullName === name);
    const commit = inputs.commits.find((c) =>
      ref ? c.hash === ref.target : c.hash.startsWith(name),
    );
    // "7f8e9d0  3d ago" when the commit is loaded, the hash alone otherwise.
    const hash = ref ? shortHash(ref.target) : commit ? shortHash(commit.hash) : "";
    const context = [hash, commit ? inputs.ago(commit.author.time) : ""]
      .filter((part) => part !== "")
      .join("  ");
    rows.push({
      key: `endpoint:${name}`,
      section: "endpoints",
      label: name,
      context,
      lane: ref ? (inputs.lanes.get(ref.fullName) ?? 0) : 0,
      choice: { kind: "revision", rev: ref?.fullName ?? name, label: ref?.name ?? name },
      kind: ref ? (ref.kind === "tag" ? "tag" : "branch") : "commit",
    });
  }
  return rows;
}
