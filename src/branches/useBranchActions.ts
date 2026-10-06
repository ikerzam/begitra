// The actions of a ref, run from the sidebar rows' menu and from the graph's ref
// badges. A local branch is checked out by name, a remote branch as the local branch that
// tracks it, a tag detached at its commit; the rest opens the dialogs of the branches and
// remotes stores, merges or rebases, pulls or fetches from a remote branch's remote, compares
// with the current branch, pushes, or copies a name. The stash badge's actions run on the
// stash the badge names, through the stash store.

import { nextTick } from "vue";

import type { Ref as GitRef } from "@/ipc/schemas";
import { copyText } from "@/shell/clipboard";
import { shortHash } from "@/shell/format";
import { useBranchesStore, type RemoteDelete } from "@/stores/branches";
import { useCompareStore } from "@/stores/compare";
import { useRemotesStore } from "@/stores/remotes";
import { useRepoStore } from "@/stores/repo";
import { stashIndex, useStashStore, type StashRow } from "@/stores/stash";
import { useToastsStore } from "@/stores/toasts";
import { useWorktreesStore } from "@/stores/worktrees";

import { remoteOf, type RemoteBranch } from "./names";

/** What the branch menu offers; `checkout` is Enter on a sidebar row too. */
export type BranchAction =
  | "checkout"
  | "createHere"
  | "newWorktree"
  | "openWorktree"
  | "merge"
  | "rebase"
  | "compare"
  | "rename"
  | "setUpstream"
  | "push"
  | "delete"
  | "deleteTag"
  | "pullInto"
  | "fetchRemote"
  | "deleteOnRemote"
  | "pushTag"
  | "copyName";

/** What the stash badge's menu offers. */
export type StashAction = "apply" | "pop" | "drop" | "copyName" | "copyHash";

export function useBranchActions() {
  const repo = useRepoStore();
  const remotes = useRemotesStore();

  /** The remotes a remote branch's items need; a menu asks for them as it opens. */
  function ensureRemotes(): void {
    if (!remotes.loaded && !remotes.loading) void remotes.load();
  }

  /** A remote branch's remote and its name there; null for another kind or an unlisted remote. */
  function remoteOfRef(ref: GitRef): RemoteBranch | null {
    return remoteOf(ref, remotes.remotes);
  }

  /** Whether an action reads the remotes list, so waits for it when it is not listed yet. */
  function needsRemotes(kind: BranchAction, ref: GitRef): boolean {
    switch (kind) {
      case "checkout":
      case "newWorktree":
        return ref.kind === "remote-branch";
      case "delete":
        return ref.upstream !== null;
      case "pullInto":
      case "fetchRemote":
      case "deleteOnRemote":
        return true;
      default:
        return false;
    }
  }

  /** A local branch by name, a remote branch as its local branch, the rest detached. */
  function checkout(ref: GitRef): void {
    run("checkout", ref);
  }

  /** The upstream a local branch's delete can take too, with the tip it holds. */
  function upstreamDelete(ref: GitRef): RemoteDelete | null {
    const upstream = ref.upstream;
    if (!upstream) return null;
    const tracking = repo.refs.find(
      (entry) => entry.kind === "remote-branch" && entry.name === upstream,
    );
    const remote = remoteOf({ kind: "remote-branch", name: upstream }, remotes.remotes);
    if (!tracking || !remote) return null;
    return { remote: remote.remote, name: remote.branch, tip: tracking.target };
  }

  /**
   * "New worktree…": the add dialog set for the branch. A branch no worktree holds is checked
   * out as it is; one a worktree holds starts a new branch, since git checks a branch out in
   * one worktree at a time; a remote branch takes its local branch when one exists, and
   * otherwise starts a new branch of its name that tracks it.
   */
  function newWorktree(ref: GitRef, remote: RemoteBranch | null): void {
    const local =
      ref.kind === "local-branch"
        ? ref
        : remote
          ? repo.refs.find((entry) => entry.kind === "local-branch" && entry.name === remote.branch)
          : undefined;
    const worktrees = useWorktreesStore();
    if (local) {
      worktrees.openAdd(
        local.worktree === null
          ? { kind: "existing", branch: local.name }
          : { kind: "new", start: local.fullName, name: "", track: false },
      );
    } else if (remote) {
      worktrees.openAdd({ kind: "new", start: ref.fullName, name: remote.branch, track: true });
    }
  }

  function compareWith(ref: GitRef): void {
    const branch = repo.currentBranch;
    void useCompareStore().open(
      branch
        ? { kind: "revision", rev: branch.fullName, label: branch.name }
        : { kind: "revision", rev: "HEAD", label: "HEAD" },
      { kind: "revision", rev: ref.fullName, label: ref.name },
    );
  }

  /** Copies `text`; the toast names it, as "Copy path" does. */
  async function copy(text: string, key: string, params: Record<string, string>): Promise<void> {
    const toasts = useToastsStore();
    if (await copyText(text)) toasts.push({ kind: "success", message: "", key, params });
    else toasts.push({ kind: "error", message: "", key: "graph.clipboardUnavailable" });
  }

  function act(kind: BranchAction, ref: GitRef): void {
    const branches = useBranchesStore();
    const remote = remoteOfRef(ref);
    switch (kind) {
      case "checkout":
        if (ref.isCurrent) break;
        if (ref.kind === "local-branch") void branches.checkout({ kind: "branch", name: ref.name });
        else if (remote) void branches.checkoutRemote(ref.fullName, remote);
        else void branches.checkout({ kind: "detached", rev: ref.fullName });
        break;
      case "createHere":
        branches.ask({ kind: "create", start: ref.name, startLabel: ref.name });
        break;
      case "newWorktree":
        newWorktree(ref, remote);
        break;
      case "openWorktree":
        if (ref.worktree) void useWorktreesStore().openAsContext(ref.worktree);
        break;
      case "merge":
        void branches.merge(ref.name, "default");
        break;
      case "rebase":
        void branches.rebase(ref.name);
        break;
      case "compare":
        compareWith(ref);
        break;
      case "rename":
        branches.ask({ kind: "rename", name: ref.name });
        break;
      case "setUpstream":
        branches.ask({ kind: "upstream", branch: ref.name, current: ref.upstream ?? null });
        break;
      case "push":
        remotes.ask({ kind: "push", branch: ref.name });
        break;
      case "delete":
        branches.ask({
          kind: "delete",
          name: ref.name,
          force: false,
          output: "",
          remote: upstreamDelete(ref),
          alsoRemote: false,
        });
        break;
      case "deleteTag":
        ensureRemotes();
        branches.ask({ kind: "deleteTag", name: ref.name });
        break;
      case "pullInto": {
        const current = repo.currentBranch?.name;
        if (remote && current) {
          remotes.ask({
            kind: "pull",
            branch: current,
            remote: remote.remote,
            remoteBranch: remote.branch,
          });
        }
        break;
      }
      case "fetchRemote":
        if (remote) void remotes.fetch(remote.remote, false);
        break;
      case "deleteOnRemote":
        if (remote) {
          remotes.ask({
            kind: "deleteOnRemote",
            remote: remote.remote,
            branch: remote.branch,
            tip: ref.target,
          });
        }
        break;
      case "pushTag":
        remotes.ask({ kind: "pushTag", tag: ref.name });
        break;
      case "copyName":
        void copy(ref.name, "branches.nameCopied", { name: ref.name });
        break;
    }
  }

  /**
   * Runs a menu's choice. One that reads the remotes waits for the list when it is not loaded
   * yet, and is dropped when another repository opened meanwhile.
   */
  function run(kind: BranchAction, ref: GitRef): void {
    if (remotes.loaded || !needsRemotes(kind, ref)) {
      act(kind, ref);
      return;
    }
    const root = repo.repo?.root;
    void remotes.load().then(() => {
      if (repo.repo?.root === root) act(kind, ref);
    });
  }

  /** The stash row of the badge's commit; the ref itself when the list has not caught up. */
  function stashRow(ref: GitRef): StashRow {
    const listed = useStashStore().stashes.find((row) => row.hash === ref.target);
    return (
      listed ?? {
        index: stashIndex(ref.name) ?? 0,
        name: ref.name,
        message: ref.message ?? "",
        hash: ref.target,
        time: null,
      }
    );
  }

  /** The stash badge's choice; Drop… opens the sheet on the row's own confirmation. */
  function runStash(kind: StashAction, ref: GitRef): void {
    const stash = useStashStore();
    switch (kind) {
      case "apply":
        void stash.apply(stashRow(ref));
        break;
      case "pop":
        void stash.pop(stashRow(ref));
        break;
      case "drop": {
        // The sheet mounts first, so the dialog it opens takes the focus from the sheet's field.
        const row = stashRow(ref);
        stash.openSheet();
        void nextTick(() => stash.askDrop(row));
        break;
      }
      case "copyName":
        void copy(ref.name, "branches.nameCopied", { name: ref.name });
        break;
      case "copyHash":
        void copy(ref.target, "graph.hashCopied", { hash: shortHash(ref.target) });
        break;
    }
  }

  return { run, runStash, checkout, compareWith, ensureRemotes, remoteOfRef };
}
