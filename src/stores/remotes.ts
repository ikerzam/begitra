// The remotes sheet and the network: the remotes with their URLs, add and remove,
// and fetch, pull and push streamed: git's progress lines land in the status bar's operation
// as its detail while the command runs (with a cancel, which kills git), the result becomes a
// toast ("Pushed main to origin", the refs updated), a pull that stops on conflicts hands over
// to the sequencer, and a failure is an error toast with git's output one click away.

import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { remoteOf } from "@/branches/names";
import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type { NetworkEvent, PullRequest, PushRequest, Remote } from "@/ipc/schemas";
import type { StreamHandle } from "@/ipc/stream";
import { arm } from "@/motion/motion";
import { shortHash } from "@/shell/format";

import { useOperationsStore } from "./operations";
import { useRepoStore } from "./repo";
import { useSequencerStore } from "./sequencer";
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

  async function load(): Promise<void> {
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
      } else {
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
   * Runs a streamed network command: the progress lines become the operation's detail, the
   * result page is kept for the caller, and the terminal message settles the promise.
   */
  function network(
    label: string,
    params: Record<string, string>,
    start: (root: string, onEvent: (event: NetworkEvent) => void, opId: string) => StreamHandle,
    explain?: (error: AppError) => { key: string; params: Record<string, string> } | null,
  ): Promise<NetworkEvent | null> {
    const root = repo.repo?.root;
    if (!root || refusedWhileBusy()) return Promise.resolve(null);
    const opId = newOpId("network");
    operations.start(opId, label, undefined, { params, cancellable: true });
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
        if (error.code !== "op.cancelled") {
          const readable = explain?.(error) ?? {
            key: "remotes.networkFailed",
            params: { message: error.message },
          };
          toasts.push({
            kind: "error",
            message: "",
            key: readable.key,
            params: readable.params,
            output: error.detail ?? error.message,
          });
        }
        return null;
      })
      .finally(() => {
        operations.finish(opId);
        if (inFlight.value?.opId === opId) inFlight.value = null;
      });
  }

  /** Cancels the network command in flight (Escape in the status bar). */
  async function cancel(): Promise<void> {
    const current = inFlight.value;
    if (!current) return;
    await current.handle.cancel();
  }

  async function fetch(remote: string | null, prune: boolean): Promise<boolean> {
    const result = await network(
      prune ? "operations.fetchingPrune" : "operations.fetching",
      { remote: remote ?? "" },
      (root, onEvent, opId) => ipc.fetch(root, remote, prune, onEvent, opId),
    );
    // A fetch that failed or was cancelled may have moved some remote branches already.
    void repo.refreshRefs();
    if (!result) return false;
    toasts.push({
      kind: "success",
      message: "",
      key: remote ? "remotes.fetched" : "remotes.fetchedAll",
      params: { remote: remote ?? "" },
      output:
        result.kind === "result" && result.summary.length > 0 ? result.summary.join("\n") : "",
    });
    return true;
  }

  async function pull(request: PullRequest): Promise<boolean> {
    // Refused while another command runs, the dialog stays open for a second try.
    if (refusedWhileBusy()) return false;
    dismiss();
    const branch = repo.currentBranch?.name ?? "HEAD";
    const result = await network(
      request.rebase ? "operations.pullingRebase" : "operations.pulling",
      {
        branch,
        remote: request.remote ?? splitUpstream(repo.currentBranch?.upstream ?? null)?.remote ?? "",
      },
      (root, onEvent, opId) => ipc.pull(root, request, onEvent, opId),
    );
    if (!result) {
      // git may have refused and still left the merge or the rebase in progress; its fetch may
      // have moved the remote branches.
      void sequencer.load();
      void repo.refreshRefs();
      return false;
    }
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
    return true;
  }

  /** Pushes a tag alone to `remote`. */
  async function pushTag(tag: string, remote: string): Promise<boolean> {
    if (refusedWhileBusy()) return false;
    dismiss();
    const result = await network("operations.pushingTag", { tag, remote }, (root, onEvent, opId) =>
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
      output: target.tip ? `git push ${target.remote} ${target.tip}:${full}` : "",
      actionKey: target.tip ? "toast.showCommand" : undefined,
    });
    return true;
  }

  async function push(request: PushRequest): Promise<boolean> {
    if (refusedWhileBusy()) return false;
    dismiss();
    const branch = request.branch ?? repo.currentBranch?.name ?? "HEAD";
    const remote =
      request.remote ?? splitUpstream(repo.currentBranch?.upstream ?? null)?.remote ?? "origin";
    const result = await network("operations.pushing", { branch, remote }, (root, onEvent, opId) =>
      ipc.push(root, request, onEvent, opId),
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
    pushTag,
    deleteOnRemote,
    cancel,
  };
});
