/** Prop unions shared by the design-system components and their tests. */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "ghost-danger" | "destructive";

/** `md` is the 28px control height; `lg` is the 32px used inside dialogs. */
export type ControlSize = "md" | "lg";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Listed one step in, under the option before it (a worktree under its repository). */
  nested?: boolean;
  /** Muted text after the label ("not found"). */
  hint?: string;
}

/** One choice of a `RadioGroup`: the value, its label and an optional muted hint. */
export interface RadioOption {
  value: string;
  label: string;
  hint?: string;
}

export type RefKind = "local" | "current" | "remote" | "tag" | "head" | "stash";

/** `untracked` is the "?" of the unstaged list: a file git does not know yet. */
export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "unmerged";

export type DiffLineKind = "context" | "add" | "del" | "gap";

export type ToastKind = "success" | "error" | "info";

export type ProgressVariant = "neutral" | "reviewed";

export type SkeletonHeight = "graph" | "list" | "tree" | "diff";
