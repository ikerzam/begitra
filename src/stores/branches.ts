// The branch, tag and history writes as the menus and the palette reach them: checkout,
// create, rename, delete, merge, rebase, reset, the undo of HEAD's commit and its redo,
// cherry-pick, revert, tag, the upstream and the fast-forward of a branch that is not checked
// out, each through the bridge with its status bar label; the prompts the layout shows
// before the ones that ask something (a name, a mode, a confirmation); the outcomes: a stop on
// conflicts hands over to the sequencer and the changes screen, a success refreshes the refs
// and lists the history again on the new HEAD, git's refusal becomes an error toast with its
// output, and a dirty switch offers "Stash and switch".

import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";

import type { RemoteBranch } from "@/branches/names";
import { heldBy, undoPlan, type UndoPlan } from "@/branches/undoPlan";
import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type {
  CommitContext,
  MergeMode,
  Outcome,
  ResetMode,
  Switched,
  SwitchTarget,
} from "@/ipc/schemas";
import { arm } from "@/motion/motion";
import { baseName, sameFolder, shellWord, shortHash } from "@/shell/format";

import { draftIsBlank, messageOf, useChangesStore } from "./changes";
import { useOperationsStore } from "./operations";
import {
  useLocalChangesStore,
  type LocalChangesChoice,
  type LocalChangesOperation,
} from "./localChanges";
import { useRecentBranchesStore } from "./recentBranches";
import { useRemotesStore } from "./remotes";
import { headTarget, useRepoStore } from "./repo";
import { useSequencerStore } from "./sequencer";
import { useShellStore } from "./shell";
import { useToastsStore } from "./toasts";

/** A ref a delete can take on a remote too: the remote, its name there and the tip it held. */
export interface RemoteDelete {
  remote: string;
  name: string;
  tip: string;
}

/** What the layout asks before a write that needs a name, a mode or a confirmation. */
export type BranchPrompt =
  | { kind: "create"; start: string; startLabel: string }
  | { kind: "rename"; name: string }
  /**
   * `force` after git refused an unmerged branch: "Delete anyway". `remote` is the upstream
   * the delete can take too, `alsoRemote` whether it was asked (kept for "Delete anyway").
   */
  | {
      kind: "delete";
      name: string;
      force: boolean;
      output: string;
      remote?: RemoteDelete | null;
      alsoRemote?: boolean;
    }
  /** A tag's delete, confirmed: tags have no reflog. */
  | { kind: "deleteTag"; name: string }
  | { kind: "upstream"; branch: string; current: string | null }
  | { kind: "tag"; rev: string; label: string }
  | { kind: "reset"; rev: string; label: string; branch: string }
  /** The last commit is on `remote` already: its undo asks first. */
  | { kind: "undoCommit"; hash: string; label: string; remote: string }
  /** The branch is checked out in the worktree at `path`: git checks it out in one only. */
  | { kind: "heldElsewhere"; branch: string; path: string };

/**
 * The last undo of HEAD's commit, for "Redo": the repository, the branch it moved (its full
 * name; null when detached), the commit undone, its parent where HEAD went, and the message the
 * undo put in the box as the box holds it (null when the box kept a draft).
 */
export interface UndoneCommit {
  root: string;
  branch: string | null;
  hash: string;
  parent: string;
  restored: string | null;
}

/** The commit an undo is bound to: the one chosen (`expected`) or confirmed (`confirmed`). */
export interface UndoPin {
  expected?: string;
  confirmed?: string;
}

/** A remote branch to check out as the local branch that tracks it. */
export interface Tracking {
  fullName: string;
  remote: RemoteBranch;
}

/** The name of a switch target, for the messages: a ref by its short name, a commit's hash short. */
export function targetName(target: SwitchTarget): string {
  if (target.kind === "branch") return target.name;
  if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(target.rev)) return shortHash(target.rev);
  return target.rev.replace(/^refs\/(?:heads|tags|remotes)\//, "");
}

/**
 * The folder git names when it refuses a branch another worktree holds ("is already used by
 * worktree at '<path>'", "is already checked out at" before git 2.42); null for another refusal.
 */
export function heldWorktreeOf(error: Pick<AppError, "message" | "detail">): string | null {
  const output = `${error.message}\n${error.detail ?? ""}`;
  return /is already (?:used by worktree|checked out) at '(.+)'\s*$/m.exec(output)?.[1] ?? null;
}

/** git's refusal of an unmerged branch (`git branch -d`). */
export function isUnmergedDelete(error: AppError): boolean {
  return /not fully merged/i.test(`${error.message}\n${error.detail ?? ""}`);
}

export const useBranchesStore = defineStore("branches", () => {
  const repo = useRepoStore();
  const shell = useShellStore();
  const operations = useOperationsStore();
  const sequencer = useSequencerStore();
  const toasts = useToastsStore();
  const recentBranches = useRecentBranchesStore();
  const localChanges = useLocalChangesStore();

  const prompt = ref<BranchPrompt | null>(null);
  /** The write in flight, as its status bar label; null between writes. */
  const busy = ref<string | null>(null);
  /** The last undo while its redo stands; shallow, so a toast's record is the same object. */
  const undone = shallowRef<UndoneCommit | null>(null);
  /** The confirmation of an undo is planning it again. */
  const planningUndo = ref(false);
  /** The toast of the last undo, the one with "Redo". */
  let undoToast: number | null = null;
  /** The last undo can be redone: the same repository and branch, HEAD where it left it. */
  const canRedo = computed(() => {
    const last = undone.value;
    return (
      last !== null &&
      repo.repo?.root === last.root &&
      (repo.currentBranch?.fullName ?? null) === last.branch &&
      headTarget(repo.refs) === last.parent
    );
  });

  function ask(next: BranchPrompt): void {
    prompt.value = next;
  }

  function dismiss(): void {
    prompt.value = null;
  }

  /**
   * Runs a write with its label; a failure becomes an error toast unless `onError` took it. A
   * write asked while another runs is refused with a toast that says so, not dropped unseen.
   */
  async function write<T>(
    label: string,
    run: (root: string, opId: string) => Promise<T>,
    onError?: (error: AppError) => boolean,
  ): Promise<T | null> {
    const root = repo.repo?.root;
    if (!root) return null;
    if (busy.value !== null) {
      toasts.push({ kind: "info", message: "", key: "branches.busy" });
      return null;
    }
    busy.value = label;
    const opId = newOpId("branches");
    operations.start(opId, label);
    try {
      return await run(root, opId);
    } catch (failure) {
      const error = toAppError(failure);
      if (!onError?.(error)) {
        toasts.push({
          kind: "error",
          message: "",
          key: "branches.failed",
          params: { message: error.message },
          output: error.detail ?? error.message,
        });
      }
      return null;
    } finally {
      operations.finish(opId);
      busy.value = null;
    }
  }

  /** HEAD moved: the refs and the history follow, on `hash` when given. */
  function headMoved(hash?: string | null, listing: { arm?: "branches" } = {}): void {
    recentBranches.headMoved();
    repo.reloadWalk(hash ?? undefined, listing);
  }

  /**
   * An outcome: conflicts hand over to the sequencer on the changes screen; the rest toast. A
   * stash git's autostash kept, or changes it holds aside, go to the banner.
   */
  function settle(outcome: Outcome, key: string, params: Record<string, string>): void {
    const root = repo.repo?.root;
    if (root) localChanges.absorb(root, outcome);
    if (outcome.kind === "conflicts") {
      // A rebase or a pick of several commits moved HEAD before it stopped.
      void repo.refreshRefs();
      sequencer.absorb(outcome);
      void shell.setLayoutMode("changes");
      return;
    }
    void sequencer.load();
    headMoved(outcome.hash);
    toasts.push({
      kind: outcome.kind === "up-to-date" ? "info" : "success",
      message: "",
      key: outcome.kind === "up-to-date" ? "branches.upToDate" : key,
      params,
    });
  }

  /** The folder of the other worktree that holds the local branch `name`; null for none. */
  function heldElsewhere(name: string): string | null {
    const local = repo.refs.find((entry) => entry.kind === "local-branch" && entry.name === name);
    const root = repo.repo?.root;
    // The current branch is this worktree's, whatever spelling of its folder the listing has
    // (a junction, a link).
    if (!local?.worktree || local.isCurrent || !root || sameFolder(local.worktree, root)) {
      return null;
    }
    return local.worktree;
  }

  /**
   * Switches; a refusal because of local changes asks how they go ("Bring my changes", "Leave
   * them in a stash"). A branch another worktree holds is not asked of git: the prompt offers
   * that worktree, as it does when git refuses one the listing did not know.
   */
  async function checkout(target: SwitchTarget): Promise<boolean> {
    const held = target.kind === "branch" ? heldElsewhere(target.name) : null;
    if (target.kind === "branch" && held !== null) {
      ask({ kind: "heldElsewhere", branch: target.name, path: held });
      return false;
    }
    const switched = await write(
      "operations.switching",
      (root, opId) => ipc.switchTo(root, target, "refuse", opId),
      (error) => {
        const holder = heldWorktreeOf(error);
        if (holder !== null && target.kind === "branch") {
          ask({ kind: "heldElsewhere", branch: target.name, path: holder });
          return true;
        }
        return askLocalChanges(error, targetName(target), (choice) => switchWith(target, choice));
      },
    );
    if (switched) {
      headMoved();
      pushSwitched(
        target.kind === "detached" ? "branches.detached" : "branches.switched",
        targetName(target),
        switched,
      );
    }
    return switched !== null;
  }

  /**
   * The toast of a switch with no local changes in its way: a success, or, when git reported a
   * failure after switching, its notice.
   */
  function pushSwitched(key: string, name: string, switched: Switched): void {
    if (switched.notice !== null) pushNotice(name, switched.notice);
    else toasts.push({ kind: "success", message: "", key, params: { name } });
  }

  /**
   * git reported a failure after a switch it made (a post-checkout hook, such as Git LFS's): an
   * error toast that stays, since the files the hook writes may be missing, with git's words.
   */
  function pushNotice(name: string, notice: string | null): void {
    if (notice === null) return;
    toasts.push({
      kind: "error",
      message: "",
      key: "branches.switchNotice",
      params: { name },
      output: notice,
      sticky: true,
    });
  }

  /**
   * Checks out a remote branch as `git checkout <branch>` would: the local branch of its name
   * when one exists (nothing when it is the current one), else a new one that tracks it; a
   * refusal because of local changes asks how they go, as a switch does.
   */
  async function checkoutRemote(fullName: string, remote: RemoteBranch): Promise<boolean> {
    const local = repo.refs.find(
      (entry) => entry.kind === "local-branch" && entry.name === remote.branch,
    );
    if (local?.isCurrent) return false;
    if (local) return checkout({ kind: "branch", name: local.name });
    dismiss();
    const target: SwitchTarget = { kind: "branch", name: remote.branch };
    const switched = await write(
      "operations.creatingBranch",
      (root, opId) => ipc.branchCreate(root, remote.branch, fullName, true, true, "refuse", opId),
      (error) =>
        askLocalChanges(error, remote.branch, (choice) =>
          switchWith(target, choice, { fullName, remote }),
        ),
    );
    if (switched) {
      headMoved(null, { arm: "branches" });
      pushSwitched("branches.switched", remote.branch, switched);
    }
    return switched !== null;
  }

  /**
   * The question a refusal over local changes asks ("Local changes in the way"), with `run` as
   * the way through; false for another refusal, which the caller's toast shows.
   */
  function askLocalChanges(
    error: AppError,
    target: string,
    run: (choice: LocalChangesChoice) => Promise<unknown>,
    operation: LocalChangesOperation = "switch",
  ): boolean {
    if (error.code !== "git.local_changes") return false;
    localChanges.ask({ operation, target, detail: error.detail ?? error.message, run });
    return true;
  }

  /**
   * Switches again with the local changes carried over or left in a stash, the way chosen in
   * "Local changes in the way"; `tracking` is a remote branch's checkout, which makes the local
   * branch that tracks it, and `create` a new branch at its start.
   */
  async function switchWith(
    target: SwitchTarget,
    choice: LocalChangesChoice,
    tracking?: Tracking,
    create?: { start: string },
  ): Promise<boolean> {
    const mode = choice === "leave" ? "leave" : "carry";
    const name = tracking ? tracking.remote.branch : targetName(target);
    let root = "";
    const switched = await write(
      tracking || create ? "operations.creatingBranch" : "operations.switching",
      (at, opId) => {
        root = at;
        if (tracking) {
          return ipc.branchCreate(at, name, tracking.fullName, true, true, mode, opId);
        }
        if (create) return ipc.branchCreate(at, name, create.start, true, false, mode, opId);
        return ipc.switchTo(at, target, mode, opId);
      },
    );
    if (!switched) return false;
    headMoved(null, tracking || create ? { arm: "branches" } : {});
    const stash = switched.stash;
    if (switched.conflicts.length > 0) {
      // The changes came back with conflicts: the changes screen takes over, and the banner says
      // the stash keeps them. Not when git also refused a part, which only the stash holds: its
      // "Drop the stash…" would lose it, and the toast says so instead.
      sequencer.absorb({ kind: "conflicts", hash: null, conflicts: switched.conflicts, stash });
      void shell.setLayoutMode("changes");
      if (stash && switched.kept === null) {
        localChanges.keep(root, stash);
        pushNotice(name, switched.notice);
        return true;
      }
    }
    // Left in a stash, kept there when they did not come back whole (git's words in a toast that
    // stays), or brought along (saying so when what was staged came back unstaged); a failure git
    // reported in a toast of its own.
    const way =
      mode === "leave" ? "Left" : stash ? "Kept" : switched.unstaged ? "Unstaged" : "With";
    const detached = target.kind === "detached" && !tracking && !create;
    toasts.push({
      kind: way === "Kept" || way === "Unstaged" ? "info" : "success",
      message: "",
      key: `localChanges.switched${way}${detached ? "Detached" : ""}`,
      params: { name, hash: stash ? shortHash(stash) : "" },
      ...(switched.kept === null ? {} : { output: switched.kept }),
      sticky: way === "Kept" || way === "Unstaged",
    });
    pushNotice(name, switched.notice);
    return true;
  }

  async function create(name: string, start: string, checkoutIt: boolean): Promise<boolean> {
    dismiss();
    const created = await write(
      "operations.creatingBranch",
      (root, opId) => ipc.branchCreate(root, name, start, checkoutIt, false, "refuse", opId),
      (error) =>
        checkoutIt &&
        askLocalChanges(error, name, (choice) =>
          switchWith({ kind: "branch", name }, choice, undefined, { start }),
        ),
    );
    if (created) {
      // The new branch's row comes with the listing, which has its figures.
      if (checkoutIt) headMoved(null, { arm: "branches" });
      else void repo.refreshRefs({ arm: "branches" });
      pushSwitched("branches.created", name, created);
    }
    return created !== null;
  }

  async function rename(from: string, to: string): Promise<boolean> {
    dismiss();
    const done = await write("operations.renamingBranch", async (root, opId) => {
      await ipc.branchRename(root, from, to, opId);
      return true;
    });
    if (done) {
      arm("branches");
      repo.patchRefs({
        kind: "rename",
        fullName: `refs/heads/${from}`,
        name: to,
        newFullName: `refs/heads/${to}`,
      });
      void repo.refreshRefs();
    }
    return done === true;
  }

  /**
   * Deletes; git's refusal of an unmerged branch prompts "Delete anyway" with the reflog note,
   * the upstream offered again as it was. `remote`, the upstream, is deleted there too once the
   * local branch is gone, when `alsoRemote` asks.
   */
  async function remove(
    name: string,
    force: boolean,
    remote: RemoteDelete | null = null,
    alsoRemote = false,
  ): Promise<boolean> {
    dismiss();
    const done = await write(
      "operations.deletingBranch",
      async (root, opId) => {
        await ipc.branchDelete(root, name, force, opId);
        return true;
      },
      (error) => {
        if (force || !isUnmergedDelete(error)) return false;
        ask({
          kind: "delete",
          name,
          force: true,
          output: error.detail ?? error.message,
          remote,
          alsoRemote,
        });
        return true;
      },
    );
    if (done) {
      arm("branches");
      repo.patchRefs({ kind: "delete", fullName: `refs/heads/${name}` });
      void repo.refreshRefs();
      toasts.push({ kind: "success", message: "", key: "branches.deleted", params: { name } });
      if (remote !== null && alsoRemote) {
        void useRemotesStore().deleteOnRemote({
          remote: remote.remote,
          branch: remote.name,
          tip: remote.tip,
        });
      }
    }
    return done === true;
  }

  /**
   * A history write that may stop: git can also refuse and still leave the operation in
   * progress (a hook that failed after the merge, rerere's own resolution, an empty pick),
   * so a failure reloads the sequencer for the banner.
   */
  async function history(
    label: string,
    run: (root: string, opId: string) => Promise<Outcome>,
    onError?: (error: AppError) => boolean,
  ): Promise<Outcome | null> {
    const outcome = await write(label, run, onError);
    if (!outcome) {
      void sequencer.load();
      void repo.refreshRefs();
    }
    return outcome;
  }

  /** Merges `rev`; a refusal over local changes asks to set them aside and merge (`autostash`). */
  async function merge(rev: string, mode: MergeMode, autostash = false): Promise<Outcome | null> {
    const outcome = await history(
      "operations.merging",
      (root, opId) => ipc.merge(root, rev, mode, autostash, opId),
      (error) =>
        askLocalChanges(
          error,
          targetName({ kind: "detached", rev }),
          () => merge(rev, mode, true),
          "merge",
        ),
    );
    if (outcome) {
      settle(outcome, "branches.merged", { rev, into: repo.currentBranch?.name ?? "HEAD" });
    }
    return outcome;
  }

  /** Rebases onto `onto`; a refusal over local changes asks as for a merge. */
  async function rebase(onto: string, autostash = false): Promise<Outcome | null> {
    const outcome = await history(
      "operations.rebasing",
      (root, opId) => ipc.rebase(root, onto, autostash, opId),
      (error) =>
        askLocalChanges(
          error,
          targetName({ kind: "detached", rev: onto }),
          () => rebase(onto, true),
          "rebase",
        ),
    );
    if (outcome) {
      settle(outcome, "branches.rebased", { onto, branch: repo.currentBranch?.name ?? "HEAD" });
    }
    return outcome;
  }

  async function reset(rev: string, mode: ResetMode): Promise<boolean> {
    dismiss();
    const done = await write("operations.resetting", async (root, opId) => {
      await ipc.reset(root, rev, mode, opId);
      return true;
    });
    if (done) {
      headMoved();
      toasts.push({
        kind: "success",
        message: "",
        key: "branches.resetDone",
        params: { mode, rev: shortHash(rev) },
      });
    }
    return done === true;
  }

  /**
   * Undoes HEAD's commit (`undoPlan`), planned on what is there now: the commit context and the
   * refs read again, with the remotes and the conflicts. HEAD moves to the commit's parent only
   * while it is still that commit (`move_head`), so its changes stay staged and a commit made
   * meanwhile is never dropped. Amend goes off, and the message goes back in a box that holds
   * nothing the user wrote. `pin.expected` is the commit the user chose (the menu's row) and
   * `pin.confirmed` the one the confirmation of a pushed commit was about: the undo goes ahead
   * only while HEAD is still that commit. "Redo" in the toast and the palette moves HEAD back.
   */
  async function undoLastCommit(pin: UndoPin = {}): Promise<boolean> {
    const root = repo.repo?.root;
    if (!root) return false;
    const confirming = pin.confirmed !== undefined;
    // The confirmation plans again before it closes: its dialog is busy, and a second press
    // neither plans nor runs.
    if (confirming && planningUndo.value) return false;
    if (confirming) planningUndo.value = true;
    let ready: { plan: Extract<UndoPlan, { kind: "undo" }>; context: CommitContext } | null;
    try {
      ready = await planUndo(root, pin);
    } finally {
      if (confirming) planningUndo.value = false;
    }
    if (ready === null) return false;
    const { plan, context } = ready;
    const changes = useChangesStore();
    const branch = repo.currentBranch ?? null;
    dismiss();
    const moved = await write(
      "operations.undoingCommit",
      async (at, opId) => {
        await ipc.moveHead(at, plan.hash, plan.parent, branch?.fullName ?? null, opId);
        return true;
      },
      (error) => refusedAsMoved(error, "branches.undoMoved"),
    );
    if (!moved) return false;
    // Amend goes off with the commit it would amend; its borrowed message leaves untouched.
    if (changes.draft.amend) changes.setDraft({ amend: false });
    // The box takes the message when it holds nothing the user wrote: what the last undo put
    // there, untouched, counts as nothing.
    const previous = undone.value?.restored ?? null;
    const blank =
      draftIsBlank(changes.draft, context.template) ||
      (previous !== null && messageOf(changes.draft) === previous);
    const message = context.headMessage ?? "";
    const restored = message !== "" && blank ? message : null;
    if (restored !== null) changes.setMessage(restored);
    const record: UndoneCommit = {
      root,
      branch: branch?.fullName ?? null,
      hash: plan.hash,
      parent: plan.parent,
      restored: restored !== null ? messageOf(changes.draft) : null,
    };
    undone.value = record;
    headMoved(plan.parent);
    void changes.loadContext();
    // One "Redo" stands at a time: the last undo's.
    if (undoToast !== null) toasts.dismiss(undoToast);
    undoToast = toasts.push({
      kind: "success",
      message: "",
      key: restored !== null ? "branches.undone" : "branches.undoneKeptDraft",
      params: { hash: shortHash(plan.hash) },
      actionKey: "branches.redo",
      onAction: () => void redoUndone(record),
    });
    return true;
  }

  /**
   * The plan of an undo, on the commit context and the refs read again; a refusal says why
   * and answers null, as does a commit that needs the confirmation (asked here).
   */
  async function planUndo(
    root: string,
    pin: UndoPin,
  ): Promise<{ plan: Extract<UndoPlan, { kind: "undo" }>; context: CommitContext } | null> {
    const changes = useChangesStore();
    const remotes = useRemotesStore();
    const [context] = await Promise.all([
      changes.loadContext(),
      repo.refreshRefs(),
      remotes.loaded ? Promise.resolve() : remotes.load(),
      sequencer.load(),
    ]);
    if (repo.repo?.root !== root) return null;
    const branch = repo.currentBranch ?? null;
    const plan = undoPlan({
      context,
      shownHead: headTarget(repo.refs),
      conflicts: sequencer.conflicts.length > 0,
      branch: branch ? { upstream: branch.upstream, ahead: branch.ahead } : null,
      remotes: remotes.loaded ? remotes.remotes : null,
    });
    if (plan.kind === "refused" || context === null) {
      if (pin.confirmed !== undefined) dismiss();
      const failure = changes.actionError;
      // A context that could not be read is an error, git's output one click away.
      const unreadable = plan.kind === "refused" && plan.reason === "unknown" && failure !== null;
      toasts.push({
        kind: unreadable ? "error" : "info",
        message: "",
        key: `branches.undoRefused.${plan.kind === "refused" ? plan.reason : "unknown"}`,
        params: { branch: branch?.name ?? "HEAD" },
        ...(unreadable ? { output: failure.detail ?? failure.message } : {}),
      });
      return null;
    }
    const wanted = pin.confirmed ?? pin.expected;
    if (wanted !== undefined && wanted !== plan.hash) {
      dismiss();
      toasts.push({ kind: "info", message: "", key: "branches.undoMoved" });
      return null;
    }
    if (plan.pushed && plan.remote !== null && pin.confirmed === undefined) {
      ask({
        kind: "undoCommit",
        hash: plan.hash,
        label: shortHash(plan.hash),
        remote: plan.remote,
      });
      return null;
    }
    return { plan, context };
  }

  /**
   * Moves HEAD back to the commit an undo took it from (`record`, the last undo's when not
   * given), read again as the undo reads: in the same repository and on the same branch, while
   * nothing holds HEAD and HEAD is still where the undo left it; otherwise says so, since
   * moving it would drop what was committed since. The message the undo put in the box leaves
   * it, unless it was edited meanwhile.
   */
  async function redoUndone(record: UndoneCommit | null = undone.value): Promise<boolean> {
    // A toast's "Redo" redoes its own undo only: a later undo or a redo made since replaced it.
    if (record === null || undone.value !== record) {
      toasts.push({ kind: "info", message: "", key: "branches.redoStale" });
      return false;
    }
    if (repo.repo?.root !== record.root) {
      toasts.push({
        kind: "info",
        message: "",
        key: "remotes.repositoryChanged",
        params: { name: baseName(record.root) },
      });
      return false;
    }
    const changes = useChangesStore();
    const [context] = await Promise.all([
      changes.loadContext(),
      repo.refreshRefs(),
      sequencer.load(),
    ]);
    if (repo.repo?.root !== record.root || undone.value !== record) return false;
    const held = context ? heldBy(context, sequencer.conflicts.length > 0) : "unknown";
    if (held !== null) {
      toasts.push({ kind: "info", message: "", key: `branches.undoRefused.${held}` });
      return false;
    }
    if (
      (repo.currentBranch?.fullName ?? null) !== record.branch ||
      context?.head !== record.parent
    ) {
      toasts.push({ kind: "info", message: "", key: "branches.redoStale" });
      return false;
    }
    const moved = await write(
      "operations.redoingCommit",
      async (root, opId) => {
        await ipc.moveHead(root, record.parent, record.hash, record.branch, opId);
        return true;
      },
      (error) => {
        if (!refusedAsMoved(error, "branches.redoStale")) return false;
        undone.value = null;
        return true;
      },
    );
    if (!moved) return false;
    undone.value = null;
    if (undoToast !== null) toasts.dismiss(undoToast);
    undoToast = null;
    if (record.restored !== null && messageOf(changes.draft) === record.restored) {
      changes.setMessage("");
    }
    headMoved(record.hash);
    void changes.loadContext();
    toasts.push({
      kind: "success",
      message: "",
      key: "branches.redone",
      params: { hash: shortHash(record.hash) },
    });
    return true;
  }

  /** git refused a move of HEAD because HEAD moved since the plan: says so with `key`. */
  function refusedAsMoved(error: AppError, key: string): boolean {
    if (error.code !== "refs.head_moved") return false;
    toasts.push({ kind: "info", message: "", key });
    return true;
  }

  async function cherryPick(revs: string[]): Promise<Outcome | null> {
    const outcome = await history("operations.cherryPicking", (root, opId) =>
      ipc.cherryPick(root, revs, opId),
    );
    if (outcome) settle(outcome, "branches.cherryPicked", { n: String(revs.length) });
    return outcome;
  }

  async function revert(revs: string[]): Promise<Outcome | null> {
    const outcome = await history("operations.reverting", (root, opId) =>
      ipc.revert(root, revs, opId),
    );
    if (outcome) settle(outcome, "branches.reverted", { n: String(revs.length) });
    return outcome;
  }

  async function tag(name: string, rev: string, message: string | null): Promise<boolean> {
    dismiss();
    const done = await write("operations.tagging", async (root, opId) => {
      await ipc.tagCreate(root, name, rev, message, opId);
      return true;
    });
    if (done) {
      void repo.refreshRefs({ arm: "branches" });
      toasts.push({ kind: "success", message: "", key: "branches.tagged", params: { name } });
    }
    return done === true;
  }

  /**
   * Deletes a tag once confirmed, and on `remote` too when asked, after the local one. The
   * toast keeps what the tag pointed at (an annotated tag's object) with `git tag` to put it
   * back while the object exists.
   */
  async function deleteTag(name: string, remote: string | null = null): Promise<boolean> {
    dismiss();
    const done = await write("operations.deletingTag", async (root, opId) => ({
      was: await ipc.tagDelete(root, name, opId),
    }));
    if (!done) return false;
    arm("branches");
    repo.patchRefs({ kind: "delete", fullName: `refs/tags/${name}` });
    void repo.refreshRefs();
    const was = done.was ?? "";
    toasts.push({
      kind: "success",
      message: "",
      key: was ? "branches.tagDeletedWas" : "branches.tagDeleted",
      params: { name, hash: shortHash(was) },
      output: was ? `git tag ${shellWord(name)} ${was}` : "",
      actionKey: was ? "toast.showCommand" : undefined,
      // Tags have no reflog: the command is the only way back.
      sticky: was !== "",
    });
    if (remote !== null) void useRemotesStore().deleteOnRemote({ remote, tag: name, tip: was });
    return true;
  }

  async function setUpstream(branch: string, upstream: string | null): Promise<boolean> {
    dismiss();
    const done = await write("operations.settingUpstream", async (root, opId) => {
      await ipc.setUpstream(root, branch, upstream, opId);
      return true;
    });
    if (done) void repo.refreshRefs();
    return done === true;
  }

  /**
   * Moves the branch `name`, which is not checked out, to its upstream's commit when that is a
   * fast-forward; the toast says how it went, and the refs and the history follow a move.
   */
  async function fastForward(name: string, upstream: string): Promise<void> {
    dismiss();
    const outcome = await write("operations.fastForwarding", (root, opId) =>
      ipc.branchFastForward(root, name, opId),
    );
    if (outcome === null) return;
    const params = { branch: name, upstream };
    switch (outcome.kind) {
      case "moved":
        repo.reloadWalk(undefined, { arm: "branches" });
        toasts.push({
          kind: "success",
          message: "",
          key: "branches.fastForwarded",
          params: { ...params, n: outcome.commits },
        });
        break;
      case "up-to-date":
        // The listing's counts were older than the branch.
        void repo.refreshRefs();
        toasts.push({ kind: "info", message: "", key: "branches.fastForwardUpToDate", params });
        break;
      case "diverged":
        void repo.refreshRefs();
        toasts.push({ kind: "info", message: "", key: "branches.fastForwardDiverged", params });
        break;
      case "held":
        void repo.refreshRefs();
        toasts.push({
          kind: "info",
          message: "",
          key: "branches.fastForwardHeld",
          params: { ...params, folder: baseName(outcome.worktree) },
        });
        break;
    }
  }

  return {
    prompt,
    busy,
    ask,
    dismiss,
    fastForward,
    checkout,
    checkoutRemote,
    switchWith,
    create,
    rename,
    remove,
    merge,
    rebase,
    reset,
    undone,
    planningUndo,
    canRedo,
    undoLastCommit,
    redoUndone,
    cherryPick,
    revert,
    tag,
    deleteTag,
    setUpstream,
  };
});
