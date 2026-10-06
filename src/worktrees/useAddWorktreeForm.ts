// The state of the add-worktree dialog: the branch (a new one with its name, or a free local
// branch), the start point of a new branch, the path (following the branch until edited,
// checked against the disk as it changes) and the request the dialog submits. A branch's
// "New worktree…" sets it up first (`worktrees.addPreset`): a remote branch's new branch
// tracks it under the remote branch's own name, and tracks nothing under another name, since
// Begitra pushes a branch under its own name only; another start leaves it to git.

import { computed, ref, watch, type ComputedRef, type Ref } from "vue";

import * as ipc from "@/ipc/commands";
import type { WorktreeAdd } from "@/ipc/schemas";
import { useRepoStore } from "@/stores/repo";
import { useWorktreesStore } from "@/stores/worktrees";

/** The select's value for "New branch": never a branch name, git refuses `?` in refnames. */
export const NEW_BRANCH = "?new";

export interface AddWorktreeForm {
  /** `NEW_BRANCH` or the name of a free local branch. */
  branch: Ref<string>;
  /** The name of the new branch. */
  name: Ref<string>;
  /** The start point of the new branch. */
  start: Ref<string>;
  path: Ref<string>;
  isNew: ComputedRef<boolean>;
  /** Free local branches (no worktree holds them), for the select. */
  freeBranches: ComputedRef<string[]>;
  /**
   * "Start from"'s choices, by full ref name (a tag or a branch of the same short name never
   * makes git's start ambiguous): the local branches, after the preset's start when it is not
   * one.
   */
  startChoices: ComputedRef<{ ref: string; label: string }[]>;
  /** The branch the new branch will track (`--track`); null when it tracks nothing asked. */
  tracks: ComputedRef<string | null>;
  nameInvalid: ComputedRef<boolean>;
  pathExists: Ref<boolean>;
  canSubmit: ComputedRef<boolean>;
  submitting: Ref<boolean>;
  /** The user typed in the path field: it stops following the branch. */
  editPath: () => void;
  /** Adds the worktree; resolves with its path, or null when the store kept an error. */
  submit: () => Promise<string | null>;
}

/** A ref's name without its namespace: `origin/main` for `refs/remotes/origin/main`. */
export function shortRef(full: string): string {
  return full.replace(/^refs\/(?:heads|remotes|tags)\//, "");
}

/** What git refuses in a branch name, as far as a field can tell before git does. */
export function branchNameInvalid(name: string): boolean {
  const value = name.trim();
  return (
    value === "" ||
    value.startsWith("-") ||
    value.endsWith("/") ||
    value.endsWith(".lock") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\s~^:?*[\\\x00-\x1f\x7f]/.test(value)
  );
}

export function useAddWorktreeForm(): AddWorktreeForm {
  const repo = useRepoStore();
  const worktrees = useWorktreesStore();

  const localBranches = computed(() =>
    repo.refs
      .filter((ref) => ref.kind === "local-branch")
      .map((ref) => ({ ref: ref.fullName, label: ref.name })),
  );
  const freeBranches = computed(() =>
    repo.refs
      .filter((ref) => ref.kind === "local-branch" && ref.worktree === null)
      .map((ref) => ref.name),
  );

  const preset = worktrees.addPreset;
  const branch = ref(preset?.kind === "existing" ? preset.branch : NEW_BRANCH);
  const name = ref(preset?.kind === "new" ? preset.name : "");
  const start = ref(
    preset?.kind === "new"
      ? preset.start
      : (repo.currentBranch?.fullName ?? localBranches.value[0]?.ref ?? "HEAD"),
  );
  const startChoices = computed(() =>
    preset?.kind === "new" && !localBranches.value.some((choice) => choice.ref === preset.start)
      ? [{ ref: preset.start, label: shortRef(preset.start) }, ...localBranches.value]
      : localBranches.value,
  );
  const path = ref("");
  const pathEdited = ref(false);
  const pathExists = ref(false);
  const submitting = ref(false);

  const isNew = computed(() => branch.value === NEW_BRANCH);
  /**
   * What the request asks of git about tracking: on the preset's remote start, `--track` under
   * the remote branch's own name and `--no-track` under another; elsewhere nothing, git's
   * setting deciding.
   */
  const track = computed<boolean | undefined>(() =>
    preset?.kind === "new" && preset.track && isNew.value && start.value === preset.start
      ? name.value.trim() === preset.name
      : undefined,
  );
  const tracks = computed(() =>
    track.value === true && preset?.kind === "new" ? shortRef(preset.start) : null,
  );
  const branchName = computed(() => (isNew.value ? name.value.trim() : branch.value));
  const nameInvalid = computed(
    () => isNew.value && name.value !== "" && branchNameInvalid(name.value),
  );

  // The path follows the branch until the user edits it.
  watch(
    branchName,
    (value) => {
      if (!pathEdited.value) path.value = value ? worktrees.defaultPath(value) : "";
    },
    { immediate: true },
  );

  // Each change of the path asks the disk; a late answer to an older value is dropped.
  let check = 0;
  watch(path, (value) => {
    check += 1;
    const mine = check;
    pathExists.value = false;
    const trimmed = value.trim();
    if (!trimmed) return;
    void ipc
      .pathExists(trimmed)
      .then((exists) => {
        if (mine === check) pathExists.value = exists;
      })
      .catch(() => undefined);
  });

  const canSubmit = computed(
    () =>
      branchName.value !== "" &&
      !nameInvalid.value &&
      path.value.trim() !== "" &&
      !pathExists.value &&
      !submitting.value,
  );

  async function submit(): Promise<string | null> {
    if (!canSubmit.value) return null;
    const request: WorktreeAdd = {
      path: path.value.trim(),
      branch: isNew.value
        ? {
            kind: "new",
            name: branchName.value,
            start: start.value,
            ...(track.value !== undefined ? { track: track.value } : {}),
          }
        : { kind: "existing", name: branchName.value },
    };
    submitting.value = true;
    try {
      return await worktrees.add(request);
    } finally {
      submitting.value = false;
    }
  }

  return {
    branch,
    name,
    start,
    path,
    isNew,
    freeBranches,
    startChoices,
    tracks,
    nameInvalid,
    pathExists,
    canSubmit,
    submitting,
    editPath: () => {
      pathEdited.value = true;
    },
    submit,
  };
}
