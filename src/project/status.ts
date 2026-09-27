// What a member's status column says: a bulk operation's state while one ran,
// otherwise a missing folder, a summary that could not be read, or the operation in progress.

import type { OverviewRow } from "@/stores/overview";

import type { BulkKind, MemberRun } from "./run";

export type StatusTone = "fg" | "muted" | "warn" | "danger";
export type StatusIcon = "check" | "minus" | "alert";

export interface RowStatus {
  tone: StatusTone;
  icon: StatusIcon | null;
  text: string;
  /** The progress bar's value while an operation runs; null sweeps. Absent otherwise. */
  progress?: number | null;
  /** git's output, one click away in the row. */
  output?: string;
}

type Translate = (key: string, params?: Record<string, unknown>) => string;

/** The text of a run's state; `kind` names what runs. */
function runStatus(run: MemberRun, kind: BulkKind, t: Translate): RowStatus | null {
  switch (run.state) {
    case "queued":
      return { tone: "muted", icon: null, text: t("project.run.queued") };
    case "running":
      return {
        tone: "fg",
        icon: null,
        text: t(`project.run.running.${kind}`),
        progress: run.progress,
      };
    case "done":
      // A worktree fetched with its repository says so in its Fetched column.
      if (run.outcome === "fetched-with") return null;
      return {
        tone: run.outcome === "up-to-date" ? "muted" : "fg",
        icon: "check",
        text: t(`project.run.done.${run.outcome}`, { name: run.with ?? "" }),
      };
    case "skipped":
      return {
        tone: "muted",
        icon: "minus",
        text: t("project.run.skipped", {
          reason: t(`project.skip.${run.reason}`, {
            operation: run.operation ? t(`project.operationWord.${run.operation}`) : "",
            remote: run.remote ?? "",
          }),
        }),
      };
    case "failed":
      return {
        tone: "danger",
        icon: "alert",
        text: run.reason === "other" ? run.message : t(`project.failure.${run.reason}`),
        output: run.output,
      };
    case "stopped":
      return { tone: "muted", icon: "minus", text: t("project.run.stopped") };
  }
}

/** The status column of `row`, with `run` its state in the bulk operation of `kind`, if any. */
export function rowStatus(
  row: OverviewRow,
  run: MemberRun | undefined,
  kind: BulkKind | null,
  t: Translate,
): RowStatus | null {
  if (run && kind) return runStatus(run, kind, t);
  if (row.missing) return { tone: "warn", icon: "alert", text: t("project.missing") };
  if (row.error) {
    return {
      tone: "danger",
      icon: "alert",
      text: t("project.readFailed"),
      output: row.error.detail ?? row.error.message,
    };
  }
  if (row.operation !== null && row.operation !== "none") {
    return { tone: "warn", icon: null, text: t(`project.operation.${row.operation}`) };
  }
  return null;
}
