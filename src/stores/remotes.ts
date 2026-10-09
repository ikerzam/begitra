// The remotes sheet and the network: the remotes with their URLs, add and remove,
// and fetch, pull and push streamed: git's progress lines land in the status bar's operation
// as its detail while the command runs (with a cancel, which kills git), the result becomes a
// toast ("Pushed main to origin", the refs updated), a pull that stops on conflicts hands over
// to the sequencer, and a failure is an error toast with git's output one click away. With
// "Move main forward" on, a fetch or a pull that succeeded moves the main branch to its upstream
// after it (`followMain`).

import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { remoteOf } from "@/branches/names";
import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type { NetworkEvent, PullRequest, PushRequest, Remote } from "@/ipc/schemas";
import type { StreamHandle } from "@/ipc/stream";
import { arm } from "@/motion/motion";
import { isDivergedPull } from "@/remotes/gitWords";
import { baseName, sameFolder, shellWord, shortHash } from "@/shell/format";

import { useBackgroundFetchStore } from "./backgroundFetch";
import { useBulkStore } from "./bulk";
import { useLocalChangesStore } from "./localChanges";
import { useOperationsStore, type NetworkCommand } from "./operations";
import { useRepoStore } from "./repo";
import { useSequencerStore } from "./sequencer";
import { useSettingsStore } from "./settings";
import { useShellStore } from "./shell";
import { useToastsStore } from "./toasts";

/** What the layout asks before a network write. */
export type NetworkPrompt =
  | { kind: "push"; branch: string }
  /** `remote` and `remoteBranch` fill the dialog in (a remote branch's "Pull into"). */
  | { kind: "pull"; branch: string; remote?: string; remoteBranch?: string }
  | { kind: "pushTag"; tag: string }
  /** A remote branch's "Delete on <remote>…": `tip` restores it. */
  | { kind: "deleteOnRemote"; remote: string; branch: string; tip: string }
  | { kind: "removeRemote"; name: string };

/** How a failed network command reads in its toast, and what its action does. */
interface Explained {
  key: string;
  params: Record<string, string>;
  /** The toast's own action in place of "Show git output", which then shows at once. */
  actionKey?: string;
  onAction?: () => void;
}

/** What a push carries besides its request. */
export interface PushOptions {
  /** A commit and push: its commit is made, so a failure offers "Push again". */
  retry?: boolean;
  /** The pushed commit replaces one by amending it: a rejection needs a force, not a pull. */
  amended?: boolean;
}

/** git refused the push because the remote holds commits the branch lacks (`LC_ALL=C` keeps the words). */
export function isRejectedPush(output: string): boolean {
  return /\[rejected\]/.test(output) && /fetch first|non-fast-forward/.test(output);
}
/** The upstream of a branch split into its remote and branch (`origin/main`). */
export function splitUpstream(upstream: string | null): { remote: string; branch: string } | null {
  if (!upstream) return null;
  const at = upstream.indexOf("/");
  if (at <= 0) return null;
  return { remote: upstream.slice(0, at), branch: upstream.slice(at + 1) };
}

export const useRemotesStore = defineStore("remotes", () => {
  const repo = useRepoStore();
  const shell = useShellStore();
  const operations = useOperationsStore();
  const sequencer = useSequencerStore();
  const localChanges = useLocalChangesStore();
  const settings = useSettingsStore();
  const toasts = useToastsStore();

  const remotes = ref<Remote[]>([]);
  const loading = ref(false);
  const loaded = ref(false);
  /** The last failed listing, for the sheet's banner. */
  const loadError = ref<AppError | null>(null);
  const sheetOpen = ref(false);
  const prompt = ref<NetworkPrompt | null>(null);
  /** The network command in flight, for the cancel; null between them. */
  const inFlight = ref<{ opId: string; handle: StreamHandle } | null>(null);
  /** The list write in flight (add, remove), as its label. */
  const busy = ref<string | null>(null);
  let serial = 0;
  /** The main branch's moves after a fetch or a pull, one after another: two at once would race
   * for its lock and one would fail for nothing. */
  let mainMoves: Promise<void> = Promise.resolve();

  // Another repository's remotes are not this one's: the list goes with the repository.
  watch(
    () => repo.repo?.root,
    () => {
      serial += 1;
      remotes.value = [];
      loaded.value = false;
      loading.value = false;
      loadError.value = null;
      if (sheetOpen.value) void load();
    },
  );

  /** The remotes' names, the current branch's remote first: where a remote to pick starts. */
  const preferred = computed<string[]>(() => {
    const names = remotes.value.map((entry) => entry.name);
    const upstream = repo.currentBranch?.upstream ?? null;
    const first =
      upstream === null
        ? undefined
        : remoteOf({ kind: "remote-branch", name: upstream }, remotes.value)?.remote;
    return first === undefined ? names : [first, ...names.filter((name) => name !== first)];
  });

  /**
   * Lists the remotes again. `quiet` keeps a failure out of the toasts: a menu that asked for the
   * list to build links offers none, and the sheet and the network dialogs say why.
   */
  async function load(options: { quiet?: boolean } = {}): Promise<void> {
    const root = repo.repo?.root;
    if (!root || repo.state.kind !== "ready") {
      remotes.value = [];
      loaded.value = false;
      return;
    }
    serial += 1;
    const mine = serial;
    loading.value = true;
    loadError.value = null;
    try {
      const listed = await ipc.remotes(root);
      if (mine === serial) {
        remotes.value = listed;
        loaded.value = true;
      }
    } catch (failure) {
      if (mine !== serial) return;
      const error = toAppError(failure);
      // The sheet shows the failure in the list's place; a dialog that needed the list toasts.
      if (sheetOpen.value) {
        loadError.value = error;
      } else if (!options.quiet) {
        toasts.push({
          kind: "error",
          message: "",
          key: "remotes.loadFailed",
          params: { message: error.message },
          output: error.detail ?? error.message,
        });
      }
    } finally {
      if (mine === serial) loading.value = false;
    }
  }

  async function openSheet(): Promise<void> {
    sheetOpen.value = true;
    await load();
  }

  function closeSheet(): void {
    sheetOpen.value = false;
  }

  /**
   * The watcher: `refs` covers the configuration (a remote added from a terminal). The open
   * sheet lists the remotes again; a list read for a dialog is read again by the next one.
   */
  function onRepoChanged(kinds: string[]): void {
    if (!kinds.includes("refs")) return;
    if (sheetOpen.value) void load();
    else loaded.value = false;
  }

  /** Opens a dialog; the push and pull dialogs list the remotes, so they load once. */
  function ask(next: NetworkPrompt): void {
    prompt.value = next;
    if (next.kind !== "removeRemote" && !loaded.value && !loading.value) void load();
  }

  function dismiss(): void {
    prompt.value = null;
  }

  /** One network command at a time: another one asked meanwhile is refused with a toast. */
  function refusedWhileBusy(): boolean {
    if (!inFlight.value) return false;
    toasts.push({ kind: "info", message: "", key: "remotes.busy" });
    return true;
  }

  async function write(label: string, run: (root: string, opId: string) => Promise<unknown>) {
    const root = repo.repo?.root;
    if (!root || busy.value !== null) return false;
    busy.value = label;
    const opId = newOpId("remotes");
    operations.start(opId, label);
    try {
      await run(root, opId);
      await load();
      return true;
    } catch (failure) {
      const error = toAppError(failure);
      toasts.push({
        kind: "error",
        message: "",
        key: "remotes.failed",
        params: { message: error.message },
        output: error.detail ?? error.message,
      });
      return false;
    } finally {
      operations.finish(opId);
      busy.value = null;
    }
  }

  function add(name: string, url: string): Promise<boolean> {
    return write("operations.addingRemote", (root, opId) => ipc.remoteAdd(root, name, url, opId));
  }

  async function remove(name: string): Promise<boolean> {
    dismiss();
    const done = await write("operations.removingRemote", (root, opId) =>
      ipc.remoteRemove(root, name, opId),
    );
    if (done) void repo.refreshRefs();
    return done;
  }

  /**
   * Waits for the fetch in the background running on `root`'s repository, if one runs: two git
   * processes would race for its locks. The status bar says so at once, and Escape cancels the
   * wait and that fetch. False when the wait was cancelled, or another repository opened
   * meanwhile.
   */
  async function afterBackground(root: string, command: NetworkCommand): Promise<boolean> {
    const background = useBackgroundFetchStore();
    const pending = background.idle(root);
    if (!pending) return true;
    const opId = newOpId("network-wait");
    operations.start(opId, "operations.waitingForBackgroundFetch", undefined, {
      cancellable: true,
      cancels: command,
    });
    let cancelled = false;
    inFlight.value = {
      opId,
      handle: {
        opId,
        done: pending,
        cancel: async () => {
          cancelled = true;
          await background.cancel(root);
        },
      },
    };
    try {
      await pending;
    } finally {
      operations.finish(opId);
      if (inFlight.value?.opId === opId) inFlight.value = null;
    }
    return !cancelled && repo.repo?.root === root;
  }

  /**
   * Runs a streamed network command once the repository's fetch in the background, if one
   * runs, has ended: the progress lines become the operation's detail, the result page is kept
   * for the caller, and the terminal message settles the promise; a failure `onError` takes
   * shows no toast.
   */
  async function network(
    command: NetworkCommand,
    label: string,
    params: Record<string, string>,
    start: (root: string, onEvent: (event: NetworkEvent) => void, opId: string) => StreamHandle,
    explain?: (error: AppError) => Explained | null,
    onError?: (error: AppError) => boolean,
  ): Promise<NetworkEvent | null> {
    const root = repo.repo?.root;
    if (!root || refusedWhileBusy()) return null;
    // Without a fetch in the background there, the command starts at once, in this call.
    if (useBackgroundFetchStore().idle(root) && !(await afterBackground(root, command))) {
      return null;
    }
    const opId = newOpId("network");
    operations.start(opId, label, undefined, { params, cancellable: true, cancels: command });
    let last: NetworkEvent | null = null;
    const handle = start(
      root,
      (event) => {
        if (event.kind === "progress") {
          operations.setDetail(opId, event.line);
          // git's meter carries its own total ("Writing objects:  45% (12/27)"); the bar follows it.
          const percent = /(\d+)%/.exec(event.line);
          if (percent?.[1] !== undefined) operations.progress(opId, Number(percent[1]), 100);
        } else {
          last = event;
        }
      },
      opId,
    );
    inFlight.value = { opId, handle };
    return handle.done
      .then(() => last)
      .catch((failure: unknown) => {
        const error = toAppError(failure);
        if (error.code !== "op.cancelled" && !onError?.(error)) {
          const readable: Explained = explain?.(error) ?? {
            key: "remotes.networkFailed",
            params: { message: error.message },
          };
          toasts.push({
            kind: "error",
            message: "",
            key: readable.key,
            params: readable.params,
            output: error.detail ?? error.message,
            ...(readable.onAction
              ? { actionKey: readable.actionKey, onAction: readable.onAction }
              : {}),
          });
        }
        return null;
      })
      .finally(() => {
        operations.finish(opId);
        if (inFlight.value?.opId === opId) inFlight.value = null;
      });
  }

  /**
   * With "Move main forward" on, moves the main branch of `root` to its upstream after a fetch
   * or a pull there succeeded, once the moves asked before it are done; the fetch or the pull
   * answers after the move, so what lists the branches next (the cleanup's dialog) reads main
   * moved. While `root` is still the open repository, a move shows the fast-forward's toast and
   * lists the refs again, and a failure shows git's output; up to date, commits of its own, a
   * worktree that has it checked out and no main branch say nothing.
   */
  function followMain(root: string | undefined): Promise<void> {
    if (!root || !settings.values.moveMainAfterFetch) return mainMoves;
    mainMoves = mainMoves.then(() => moveMain(root));
    return mainMoves;
  }

  async function moveMain(root: string): Promise<void> {
    const stillOpen = () => sameFolder(root, repo.repo?.root ?? "");
    try {
      const answer = await ipc.mainFastForward(root);
      const outcome = answer?.outcome;
      if (!answer || outcome?.kind !== "moved" || !stillOpen()) return;
      void repo.refreshRefs({ arm: "branches" });
      toasts.push({
        kind: "success",
        message: "",
        key: "branches.fastForwarded",
        params: { branch: answer.branch, upstream: answer.upstream, n: outcome.commits },
      });
    } catch (failure) {
      if (!stillOpen()) return;
      const error = toAppError(failure);
      toasts.push({
        kind: "error",
        message: "",
        key: "remotes.mainForwardFailed",
        output: error.detail ?? error.message,
      });
    }
  }

  /** Cancels the network command in flight (Escape in the status bar). */
  async function cancel(): Promise<void> {
    const current = inFlight.value;
    if (!current) return;
    await current.handle.cancel();
  }

  async function fetch(remote: string | null, prune: boolean): Promise<boolean> {
    const root = repo.repo?.root;
    const result = await network(
      "fetch",
      prune ? "operations.fetchingPrune" : "operations.fetching",
      { remote: remote ?? "" },
      (root, onEvent, opId) => ipc.fetch(root, remote, prune, onEvent, opId),
    );
    // A fetch that failed or was cancelled may have moved some remote branches already.
    void repo.refreshRefs();
    if (!result) return false;
    // A fetch by hand that worked signed in: the fetch in the background goes on there.
    if (root) useBackgroundFetchStore().resume(root);
    toasts.push({
      kind: "success",
      message: "",
      key: remote ? "remotes.fetched" : "remotes.fetchedAll",
      params: { remote: remote ?? "" },
      output:
        result.kind === "result" && result.summary.length > 0 ? result.summary.join("\n") : "",
    });
    await followMain(root);
    return true;
  }

  /**
   * Pulls as `request` says. A fast-forward-only pull that git refuses because the branch
   * diverged says so and offers "Pull…", the dialog where a merge or a rebase is chosen, on that
   * branch in the repository the pull ran in. One git refuses over local changes asks to set
   * them aside and pull again (`autostash`), naming what it pulls: the remote branch asked for,
   * or the upstream. A stash git kept goes to the banner, or to a toast without conflicts.
   */
  async function pull(request: PullRequest): Promise<boolean> {
    // Refused while another command runs, the dialog stays open for a second try.
    if (refusedWhileBusy()) return false;
    dismiss();
    const root = repo.repo?.root;
    const branch = repo.currentBranch?.name ?? "HEAD";
    const upstream = repo.currentBranch?.upstream ?? "";
    const explain = (error: AppError): Explained | null =>
      request.ffOnly && isDivergedPull(error.detail ?? error.message)
        ? {
            key: "remotes.pullDiverged",
            params: { branch, upstream },
            actionKey: "remotes.pullAction",
            onAction: inRepository(root, () => ask({ kind: "pull", branch })),
          }
        : null;
    const result = await network(
      "pull",
      request.rebase ? "operations.pullingRebase" : "operations.pulling",
      {
        branch,
        remote: request.remote ?? splitUpstream(upstream || null)?.remote ?? "",
      },
      (root, onEvent, opId) => ipc.pull(root, request, onEvent, opId),
      explain,
      (error) => {
        if (error.code !== "git.local_changes") return false;
        localChanges.ask({
          operation: "pull",
          target:
            request.remote && request.branch
              ? `${request.remote}/${request.branch}`
              : upstream || branch,
          detail: error.detail ?? error.message,
          run: () => pull({ ...request, autostash: true }),
        });
        return true;
      },
    );
    if (!result) {
      // git may have refused and still left the merge or the rebase in progress; its fetch may
      // have moved the remote branches.
      void sequencer.load();
      void repo.refreshRefs();
      return false;
    }
    if (result.kind === "outcome" && root) localChanges.absorb(root, result.outcome);
    if (result.kind === "outcome" && result.outcome.kind === "conflicts") {
      void repo.refreshRefs();
      sequencer.absorb(result.outcome);
      void shell.setLayoutMode("changes");
      return true;
    }
    void sequencer.load();
    const hash = result.kind === "outcome" ? result.outcome.hash : null;
    repo.reloadWalk(hash ?? undefined);
    toasts.push({
      kind: result.kind === "outcome" && result.outcome.kind === "up-to-date" ? "info" : "success",
      message: "",
      key:
        result.kind === "outcome" && result.outcome.kind === "up-to-date"
          ? "remotes.pullUpToDate"
          : "remotes.pulled",
      params: { branch },
    });
    await followMain(root);
    return true;
  }

  /** Pushes a tag alone to `remote`. */
  async function pushTag(tag: string, remote: string): Promise<boolean> {
    if (refusedWhileBusy()) return false;
    dismiss();
    const result = await network(
      "push",
      "operations.pushingTag",
      { tag, remote },
      (root, onEvent, opId) =>
        ipc.push(
          root,
          { remote, branch: null, tag, delete: false, setUpstream: false, forceWithLease: false },
          onEvent,
          opId,
        ),
    );
    if (!result) return false;
    toasts.push({
      kind: "success",
      message: "",
      key: "remotes.tagPushed",
      params: { tag, remote },
    });
    return true;
  }

  /**
   * Deletes a branch or a tag on `remote`, by its full name; the toast keeps the tip it held
   * and the command that puts it back.
   */
  async function deleteOnRemote(target: {
    remote: string;
    branch?: string;
    tag?: string;
    tip: string;
  }): Promise<boolean> {
    if (refusedWhileBusy()) return false;
    dismiss();
    const name = target.branch ?? target.tag ?? "";
    const result = await network(
      "push",
      "operations.deletingOnRemote",
      { name, remote: target.remote },
      (root, onEvent, opId) =>
        ipc.push(
          root,
          {
            remote: target.remote,
            branch: target.branch ?? null,
            tag: target.tag ?? null,
            delete: true,
            setUpstream: false,
            forceWithLease: false,
          },
          onEvent,
          opId,
        ),
      // A branch's delete leases on its remote-tracking ref: git refuses it when the branch
      // moved or left the remote since the last fetch.
      (error) =>
        /stale info/.test(error.detail ?? "")
          ? { key: "remotes.deleteStale", params: { name, remote: target.remote } }
          : null,
    );
    if (!result) return false;
    if (target.branch !== undefined) {
      arm("branches");
      repo.patchRefs({
        kind: "delete",
        fullName: `refs/remotes/${target.remote}/${target.branch}`,
      });
    }
    void repo.refreshRefs();
    const full = target.branch !== undefined ? `refs/heads/${name}` : `refs/tags/${name}`;
    toasts.push({
      kind: "success",
      message: "",
      key: target.tip ? "remotes.deletedOnRemoteWas" : "remotes.deletedOnRemote",
      params: { name, remote: target.remote, hash: shortHash(target.tip) },
      output: target.tip
        ? `git push ${shellWord(target.remote)} ${shellWord(`${target.tip}:${full}`)}`
        : "",
      actionKey: target.tip ? "toast.showCommand" : undefined,
    });
    return true;
  }

  /**
   * Runs `act` in the repository open when it was offered, or says that repository is no longer
   * open: a toast's action outlives a switch to another repository.
   */
  function inRepository(root: string | undefined, act: () => void): () => void {
    return () => {
      if (root !== undefined && repo.repo?.root === root) act();
      else
        toasts.push({
          kind: "info",
          message: "",
          key: "remotes.repositoryChanged",
          params: { name: baseName(root ?? "") },
        });
    };
  }

  /**
   * Pushes as `request` says. A push the remote rejects for commits the branch lacks says so and
   * offers "Pull…" on the checked-out branch, unless it follows an amend (`amended`), whose
   * replacement only a forced push moves; with `retry` (a commit and push, whose commit is made)
   * any other failure offers "Push again". Both act in the repository the push ran in.
   */
  async function push(request: PushRequest, options: PushOptions = {}): Promise<boolean> {
    if (refusedWhileBusy()) return false;
    dismiss();
    const root = repo.repo?.root;
    const branch = request.branch ?? repo.currentBranch?.name ?? "HEAD";
    const remote =
      request.remote ?? splitUpstream(repo.currentBranch?.upstream ?? null)?.remote ?? "origin";
    const explain = (error: AppError): Explained | null => {
      if (isRejectedPush(error.detail ?? error.message)) {
        if (options.amended)
          return { key: "remotes.pushRejectedAmend", params: { branch, remote } };
        const pullable = branch === repo.currentBranch?.name;
        return {
          key: "remotes.pushRejected",
          params: { branch, remote },
          ...(pullable
            ? {
                actionKey: "remotes.pullAction",
                onAction: inRepository(root, () => ask({ kind: "pull", branch })),
              }
            : {}),
        };
      }
      if (!options.retry) return null;
      return {
        key: "remotes.pushFailed",
        params: { branch, remote },
        actionKey: "remotes.pushAgain",
        onAction: inRepository(root, () => void push(request, options)),
      };
    };
    const result = await network(
      "push",
      "operations.pushing",
      { branch, remote },
      (root, onEvent, opId) => ipc.push(root, request, onEvent, opId),
      explain,
    );
    if (!result) return false;
    void repo.refreshRefs();
    toasts.push({
      kind: "success",
      message: "",
      key: "remotes.pushed",
      params: { branch, remote },
      output:
        result.kind === "result" && result.summary.length > 0 ? result.summary.join("\n") : "",
    });
    return true;
  }

  /**
   * A push asked while a fetch, pull or push, or a project's bulk operation, runs: it runs once
   * they end, the toast saying so, and not at all if another repository opened meanwhile, since
   * the push commands act on the open one.
   */
  function pushWhenFree(request: PushRequest, options: PushOptions = {}): void {
    const root = repo.repo?.root;
    const bulk = useBulkStore();
    const blocked = () => inFlight.value !== null || bulk.running;
    if (!blocked()) {
      void push(request, options);
      return;
    }
    toasts.push({ kind: "info", message: "", key: "remotes.pushWaits" });
    const stop = watch(blocked, (now) => {
      if (now) return;
      stop();
      inRepository(root, () => void push(request, options))();
    });
  }

  return {
    remotes,
    preferred,
    loading,
    loaded,
    loadError,
    sheetOpen,
    prompt,
    inFlight,
    busy,
    load,
    openSheet,
    closeSheet,
    onRepoChanged,
    ask,
    dismiss,
    add,
    remove,
    fetch,
    pull,
    push,
    pushWhenFree,
    pushTag,
    deleteOnRemote,
    cancel,
  };
});
