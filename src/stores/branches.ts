// The branch, tag and history writes as the menus and the palette reach them:
// checkout, create, rename, delete, merge, rebase, reset, cherry-pick, revert, tag and the
// upstream, each through the bridge with its status bar label; the prompts the layout shows
// before the ones that ask something (a name, a mode, a confirmation); the outcomes: a stop on
// conflicts hands over to the sequencer and the changes screen, a success refreshes the refs
// and lists the history again on the new HEAD, git's refusal becomes an error toast with its
// output, and a dirty switch offers "Stash and switch".

import { defineStore } from "pinia";
import { ref } from "vue";

import type { RemoteBranch } from "@/branches/names";
import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type { MergeMode, Outcome, ResetMode, SwitchTarget } from "@/ipc/schemas";
import { arm } from "@/motion/motion";
import { shortHash } from "@/shell/format";

import { useOperationsStore } from "./operations";
import { useRemotesStore } from "./remotes";
import { useRepoStore } from "./repo";
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
  /**
   * git refused the switch because of local changes: "Stash and switch". `tracking` is a
   * remote branch's checkout, which makes the local branch that tracks it.
   */
  | { kind: "dirtySwitch"; target: SwitchTarget; output: string; tracking?: Tracking };

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

  const prompt = ref<BranchPrompt | null>(null);
  /** The write in flight, as its status bar label; null between writes. */
  const busy = ref<string | null>(null);

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

  /** Switches; a refusal because of local changes prompts "Stash and switch". */
  async function checkout(target: SwitchTarget): Promise<boolean> {
    const done = await write(
      "operations.switching",
      async (root, opId) => {
        await ipc.switchTo(root, target, opId);
        return true;
      },
      (error) => {
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
      output: was ? `git tag ${name} ${was}` : "",
      actionKey: was ? "toast.showCommand" : undefined,
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
    cherryPick,
    revert,
    tag,
    deleteTag,
    setUpstream,
  };
});
