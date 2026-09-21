// The remotes sheet and the network: the remotes with their URLs, add and remove,
// and fetch, pull and push streamed: git's progress lines land in the status bar's operation
// as its detail while the command runs (with a cancel, which kills git), the result becomes a
// toast ("Pushed main to origin", the refs updated), a pull that stops on conflicts hands over
// to the sequencer, and a failure is an error toast with git's output one click away.

import { defineStore } from "pinia";
import { ref } from "vue";

import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type { NetworkEvent, PullRequest, PushRequest, Remote } from "@/ipc/schemas";
import type { StreamHandle } from "@/ipc/stream";

import { useOperationsStore } from "./operations";
import { useRepoStore } from "./repo";
import { useSequencerStore } from "./sequencer";
import { useShellStore } from "./shell";
import { useToastsStore } from "./toasts";

/** What the layout asks before a network write. */
export type NetworkPrompt =
  | { kind: "push"; branch: string }
  | { kind: "pull"; branch: string }
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

  /** Opens a dialog; the push and pull dialogs list the remotes, so they load once. */
  function ask(next: NetworkPrompt): void {
    prompt.value = next;
    if (next.kind !== "removeRemote" && !loaded.value && !loading.value) void load();
  }

  function dismiss(): void {
    prompt.value = null;
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
  ): Promise<NetworkEvent | null> {
    const root = repo.repo?.root;
    if (!root || inFlight.value) return Promise.resolve(null);
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
          toasts.push({
            kind: "error",
            message: "",
            key: "remotes.networkFailed",
            params: { message: error.message },
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
    if (!result) return false;
    void repo.refreshRefs();
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
      // git may have refused and still left the merge or the rebase in progress.
      void sequencer.load();
      return false;
    }
    if (result.kind === "outcome" && result.outcome.kind === "conflicts") {
      sequencer.absorb(result.outcome);
      void shell.setLayoutMode("changes");
      return true;
    }
    void sequencer.load();
    void repo.refreshRefs();
    const hash = result.kind === "outcome" ? result.outcome.hash : null;
    repo.restartWalk(repo.walkScope, repo.walkFilter, hash ?? undefined);
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

  async function push(request: PushRequest): Promise<boolean> {
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
    ask,
    dismiss,
    add,
    remove,
    fetch,
    pull,
    push,
    cancel,
  };
});
