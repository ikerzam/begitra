// The branch, tag and history writes as the menus and the palette reach them: checkout,
// create, rename, delete, merge, rebase, reset, the undo of HEAD's commit and its redo,
// cherry-pick, revert, tag and the upstream, each through the bridge with its status bar
// label; the prompts the layout shows
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
import type { CommitContext, MergeMode, Outcome, ResetMode, SwitchTarget } from "@/ipc/schemas";
import { arm } from "@/motion/motion";
import { baseName, sameFolder, shellWord, shortHash } from "@/shell/format";

import { draftIsBlank, messageOf, useChangesStore } from "./changes";
import { useOperationsStore } from "./operations";
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
  | { kind: "heldElsewhere"; branch: string; path: string }
  /**
   * git refused the switch because of local changes: "Stash and switch". `tracking` is a
   * remote branch's checkout, which makes the local branch that tracks it.
   */
  | { kind: "dirtySwitch"; target: SwitchTarget; output: string; tracking?: Tracking };

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

/** git's refusal of a switch that would overwrite local changes, in its own words. */
export function isDirtySwitch(error: AppError): boolean {
  const output = `${error.message}\n${error.detail ?? ""}`;
  return /would be overwritten|local changes|uncommitted changes/i.test(output);
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

  /** An outcome: conflicts hand over to the sequencer on the changes screen; the rest toast. */
  function settle(outcome: Outcome, key: string, params: Record<string, string>): void {
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
   * Switches; a refusal because of local changes prompts "Stash and switch". A branch another
   * worktree holds is not asked of git: the prompt offers that worktree, as it does when git
   * refuses one the listing did not know.
   */
  async function checkout(target: SwitchTarget): Promise<boolean> {
    const held = target.kind === "branch" ? heldElsewhere(target.name) : null;
    if (target.kind === "branch" && held !== null) {
      ask({ kind: "heldElsewhere", branch: target.name, path: held });
      return false;
    }
    const done = await write(
      "operations.switching",
      async (root, opId) => {
        await ipc.switchTo(root, target, opId);
        return true;
      },
      (error) => {
        const holder = heldWorktreeOf(error);
        if (holder !== null && target.kind === "branch") {
          ask({ kind: "heldElsewhere", branch: target.name, path: holder });
          return true;
        }
        if (!isDirtySwitch(error)) return false;
        ask({ kind: "dirtySwitch", target, output: error.detail ?? error.message });
        return true;
      },
    );
    if (done) {
      headMoved();
      toasts.push({
        kind: "success",
        message: "",
        key: target.kind === "detached" ? "branches.detached" : "branches.switched",
        params: { name: targetName(target) },
      });
    }
    return done === true;
  }

  /**
   * Checks out a remote branch as `git checkout <branch>` would: the local branch of its name
   * when one exists (nothing when it is the current one), else a new one that tracks it; a
   * refusal because of local changes prompts "Stash and switch" as a switch does.
   */
  async function checkoutRemote(fullName: string, remote: RemoteBranch): Promise<boolean> {
    const local = repo.refs.find(
      (entry) => entry.kind === "local-branch" && entry.name === remote.branch,
    );
    if (local?.isCurrent) return false;
    if (local) return checkout({ kind: "branch", name: local.name });
    dismiss();
    const target: SwitchTarget = { kind: "branch", name: remote.branch };
    const done = await write(
      "operations.creatingBranch",
      async (root, opId) => {
        await ipc.branchCreate(root, remote.branch, fullName, true, true, opId);
        return true;
      },
      (error) => {
        if (!isDirtySwitch(error)) return false;
        ask({
          kind: "dirtySwitch",
          target,
          output: error.detail ?? error.message,
          tracking: { fullName, remote },
        });
        return true;
      },
    );
    if (done) {
      headMoved(null, { arm: "branches" });
      toasts.push({
        kind: "success",
        message: "",
        key: "branches.switched",
        params: { name: remote.branch },
      });
    }
    return done === true;
  }

  /** Stashes everything (untracked included), then switches; the stash stays for the user. */
  async function stashAndSwitch(target: SwitchTarget, tracking?: Tracking): Promise<boolean> {
    dismiss();
    const stashed = await write("operations.stashing", async (root, opId) => {
      await ipc.stashPush(root, { message: null, includeUntracked: true, paths: [] }, opId);
      return true;
    });
    if (!stashed) return false;
    return tracking ? checkoutRemote(tracking.fullName, tracking.remote) : checkout(target);
  }

  async function create(name: string, start: string, checkoutIt: boolean): Promise<boolean> {
    dismiss();
    const done = await write("operations.creatingBranch", async (root, opId) => {
      await ipc.branchCreate(root, name, start, checkoutIt, false, opId);
      return true;
    });
    if (done) {
      // The new branch's row comes with the listing, which has its figures.
      if (checkoutIt) headMoved(null, { arm: "branches" });
      else void repo.refreshRefs({ arm: "branches" });
      toasts.push({ kind: "success", message: "", key: "branches.created", params: { name } });
    }
    return done === true;
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
  ): Promise<Outcome | null> {
    const outcome = await write(label, run);
    if (!outcome) {
      void sequencer.load();
      void repo.refreshRefs();
    }
    return outcome;
  }

  async function merge(rev: string, mode: MergeMode): Promise<Outcome | null> {
    const outcome = await history("operations.merging", (root, opId) =>
      ipc.merge(root, rev, mode, opId),
    );
    if (outcome) {
      settle(outcome, "branches.merged", { rev, into: repo.currentBranch?.name ?? "HEAD" });
    }
    return outcome;
  }

  async function rebase(onto: string): Promise<Outcome | null> {
    const outcome = await history("operations.rebasing", (root, opId) =>
      ipc.rebase(root, onto, opId),
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

  return {
    prompt,
    busy,
    ask,
    dismiss,
    checkout,
    checkoutRemote,
    stashAndSwitch,
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
