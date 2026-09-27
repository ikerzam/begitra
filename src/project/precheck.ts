// The check before a bulk operation: a pure function of the members' summaries that
// writes nothing and sorts them into those the operation acts on and those it skips, each with
// its reason, in the rows' order. What it cannot know from a summary (a branch that already
// exists, an upstream gone from the remote) git refuses at run time, and the row says so.

import type { OverviewRow } from "@/stores/overview";

import type { BulkKind, SkipReason } from "./run";

/** A member the check sorted, with what the confirmation shows of it. */
export interface PlanItem {
  path: string;
  name: string;
  branch: string | null;
  /** The upstream's short name (`origin/main`). */
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  /** Why it is skipped; absent when the operation acts on it. */
  reason?: SkipReason;
  /** The operation in progress, for the "operation" reason. */
  operation?: string;
  /** Where its pushes go, for the "push-remote" reason. */
  remote?: string;
}

export interface BulkPlan {
  kind: BulkKind;
  /** The branch to switch to or to create; null for the network operations. */
  branch: string | null;
  acting: PlanItem[];
  skipped: PlanItem[];
}

/** Why `row` is left out of `kind`, or null when the operation acts on it. */
function skipReason(
  kind: BulkKind,
  row: OverviewRow,
  branch: string | null,
): Pick<PlanItem, "reason" | "operation" | "remote"> | null {
  if (row.missing) return { reason: "missing" };
  if (row.error) return { reason: "unread" };
  if (kind === "fetch") return null;
  if (row.operation !== null && row.operation !== "none") {
    return { reason: "operation", operation: row.operation };
  }
  const upstream = row.upstream;
  switch (kind) {
    case "pull":
      if (row.detached) return { reason: "detached" };
      if (!upstream) return { reason: "no-upstream" };
      return null;
    case "push":
      if (row.detached) return { reason: "detached" };
      if (!upstream) return { reason: "no-upstream" };
      if (upstream.remote === ".") return { reason: "local-upstream" };
      if (upstream.pushRemote !== upstream.remote) {
        return { reason: "push-remote", remote: upstream.pushRemote };
      }
      if (upstream.branch !== row.branch) return { reason: "other-name" };
      if ((row.ahead ?? 0) === 0) return { reason: "nothing-to-push" };
      return null;
    case "switch":
      if (row.dirty === true || (row.changed ?? 0) > 0) return { reason: "uncommitted" };
      if (branch !== null && row.branch === branch && !row.detached) {
        return { reason: "same-branch" };
      }
      return null;
    case "create":
      return null;
  }
}

/** Sorts `rows` for `kind` (with the `branch` to switch to or create), writing nothing. */
export function precheck(
  kind: BulkKind,
  rows: readonly OverviewRow[],
  branch: string | null = null,
): BulkPlan {
  const plan: BulkPlan = { kind, branch, acting: [], skipped: [] };
  for (const row of rows) {
    const item: PlanItem = {
      path: row.path,
      name: row.name,
      branch: row.detached ? null : row.branch,
      upstream: row.upstream?.name ?? null,
      ahead: row.ahead,
      behind: row.behind,
    };
    const skip = skipReason(kind, row, branch);
    if (skip) plan.skipped.push({ ...item, ...skip });
    else plan.acting.push(item);
  }
  return plan;
}
