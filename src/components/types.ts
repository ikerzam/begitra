/** Prop unions shared by the design-system components and their tests. */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

/** `md` is the 28px control height; `lg` is the 32px used inside dialogs. */
export type ControlSize = "md" | "lg";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export type RefKind = "local" | "current" | "remote" | "tag" | "head" | "stash";

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export type DiffLineKind = "context" | "add" | "del" | "gap";

export type ToastKind = "success" | "error" | "info";

export type ProgressVariant = "neutral" | "reviewed";

export type SkeletonHeight = "graph" | "list" | "tree" | "diff";
