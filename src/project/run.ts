// The state of a bulk operation per member: what the Overview's status column shows
// while a fetch, pull, push, switch or new branch runs over the project's repositories.

/** The five bulk operations. */
export type BulkKind = "fetch" | "pull" | "push" | "switch" | "create";

/** Why the check before a write leaves a member out. */
export type SkipReason =
  | "missing"
  | "detached"
  | "no-upstream"
  | "local-upstream"
  | "other-name"
  | "nothing-to-push"
  | "operation"
  | "uncommitted"
  | "same-branch"
  | "unread"
  | "push-remote";

/** Why a member's operation failed, sorted from git's words (`failures.ts`). */
export type FailureReason =
  | "sign-in"
  | "rejected"
  | "diverged"
  | "local-changes"
  | "network"
  | "upstream-gone"
  | "branch-exists"
  | "other";

/** How a member's operation ended well. */
export type DoneOutcome =
  "fetched" | "fetched-with" | "fast-forward" | "up-to-date" | "pushed" | "switched" | "created";

export type MemberRun =
  | { state: "queued" }
  | { state: "running"; progress: number | null }
  | { state: "done"; outcome: DoneOutcome; with?: string }
  | { state: "skipped"; reason: SkipReason; operation?: string; remote?: string }
  | { state: "failed"; reason: FailureReason; message: string; output: string }
  | { state: "stopped" };
