// The branch cleanup: the dialog that lists the local branches that can go against the main
// branch (merged into it or its upstream; gone from their remote, with or without their changes
// in it), its ticks, "Fetch and prune", and the deletion of the ticked branches with their
// worktrees. The toasts say what went and what stayed; the first keeps the `git branch` command
// that brings each deleted branch back, since `git branch -D` takes the branch's reflog with it.

import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import * as ipc from "@/ipc/commands";
import { toAppError, type AppError } from "@/ipc/errors";
import { newOpId } from "@/ipc/invoke";
import type { CleanupCandidate, DeleteOutcome, KeptReason } from "@/ipc/schemas";
import { arm } from "@/motion/motion";
import { sameFolder, shellWord } from "@/shell/format";

import { useIndexStore } from "./index";
import { useOperationsStore } from "./operations";
import { useRemotesStore } from "./remotes";
import { useRepoStore } from "./repo";
import { useToastsStore } from "./toasts";

/** The branches that stayed, grouped by why, in the order the reasons first came. */
function keptByReason(outcomes: DeleteOutcome[]): Map<KeptReason, DeleteOutcome[]> {
  const groups = new Map<KeptReason, DeleteOutcome[]>();
  for (const outcome of outcomes) {
    if (outcome.deleted) continue;
    const reason = outcome.reason ?? "failed";
    groups.set(reason, [...(groups.get(reason) ?? []), outcome]);
  }
  return groups;
}

/** The names of a group for a sentence: three, then how many more ("a, b, c +2"). */
function namesOf(group: DeleteOutcome[]): string {
  const shown = group
    .slice(0, 3)
    .map((outcome) => outcome.name)
    .join(", ");
  return group.length > 3 ? `${shown} +${group.length - 3}` : shown;
}

/** A candidate as the dialog lists it. */
export interface CleanupRow extends CleanupCandidate {
  /** Its worktree is locked: git refuses to remove it, so the row cannot be ticked. */
  locked: boolean;
  /** Unix seconds of its tip's commit, from the refs listing; null when unknown. */
  committedAt: number | null;
  /** Its changes may be missing from the main branch: gone, and main lacks them or unchecked. */
  warn: boolean;
}

export const useCleanupStore = defineStore("cleanup", () => {
  const repo = useRepoStore();
  const operations = useOperationsStore();
  const toasts = useToastsStore();

  const isOpen = ref(false);
  const loading = ref(false);
  /** The listing's failure, shown in the dialog. */
  const error = ref<AppError | null>(null);
  /** The main branch the listing compared with; null when none was found. */
  const main = ref<string | null>(null);
  const candidates = ref<CleanupCandidate[]>([]);
  /** The names ticked for deletion. */
  const ticked = ref<Set<string>>(new Set());
  /**
   * What the user ticked or unticked since the dialog opened, by name: a listing again ("Fetch and
   * prune") keeps it, so a branch unticked by hand never comes back ticked before a deletion.
   */
  const choices = new Map<string, boolean>();
  /** "Fetch and prune" runs. */
  const fetching = ref(false);
  /** The deletion runs, the dialog closed: the status bar shows it. */
  const deleting = ref(false);
  /** The listing in flight, cancelled when the dialog closes. */
  let listing: string | null = null;
  let serial = 0;

  // Another repository's branches are not this one's: the dialog closes with the repository.
  watch(
    () => repo.repo?.root,
    () => {
      if (isOpen.value) close();
      forget();
    },
  );

  const rows = computed<CleanupRow[]>(() =>
    candidates.value.map((candidate) => {
      const path = candidate.worktree;
      const worktree =
        path === null ? undefined : repo.worktrees.find((entry) => sameFolder(entry.path, path));
      const branch = repo.refs.find(
        (entry) => entry.kind === "local-branch" && entry.name === candidate.name,
      );
      return {
        ...candidate,
        locked: worktree?.locked ?? false,
        committedAt: branch?.committedAt ?? null,
        warn: candidate.reason === "gone" || candidate.reason === "gone-unchecked",
      };
    }),
  );
  /** The rows the confirm deletes: ticked and not locked, in the list's order. */
  const chosen = computed(() =>
    rows.value.filter((row) => !row.locked && ticked.value.has(row.name)),
  );
  const chosenWorktrees = computed(
    () => chosen.value.filter((row) => row.worktree !== null).length,
  );

  /** Opens the dialog from nothing and lists the candidates; refused while a deletion runs. */
  async function open(): Promise<void> {
    if (deleting.value) {
      toasts.push({ kind: "info", message: "", key: "cleanup.busy" });
      return;
    }
    forget();
    isOpen.value = true;
    await list();
  }

  /** The last listing and the user's ticks, gone. */
  function forget(): void {
    main.value = null;
    candidates.value = [];
    ticked.value = new Set();
    error.value = null;
    choices.clear();
  }

  function close(): void {
    isOpen.value = false;
    serial += 1;
    loading.value = false;
    cancelListing();
  }

  function cancelListing(): void {
    const opId = listing;
    listing = null;
    if (opId !== null) void ipc.cancelOperation(opId).catch(() => undefined);
  }

  /**
   * Lists the candidates with the worktrees (a locked one shows from their listing), ticking the
   * merged ones and the ones whose changes are in the main branch; a branch with no commits of
   * its own (an agent's new worktree) and a gone one main lacks wait to be ticked. What the user
   * ticked or unticked since the dialog opened stays as they left it.
   */
  async function list(): Promise<void> {
    const root = repo.repo?.root;
    if (!root || repo.state.kind !== "ready") return;
    cancelListing();
    serial += 1;
    const mine = serial;
    const opId = newOpId("cleanup");
    listing = opId;
    loading.value = true;
    error.value = null;
    try {
      const [listed] = await Promise.all([ipc.cleanupCandidates(root, opId), repo.loadWorktrees()]);
      if (mine !== serial) return;
      main.value = listed.main;
      candidates.value = listed.candidates;
      ticked.value = new Set(
        rows.value
          .filter(
            (row) =>
              !row.locked &&
              (choices.get(row.name) ?? (row.reason === "merged" || row.reason === "gone-applied")),
          )
          .map((row) => row.name),
      );
    } catch (failure) {
      if (mine !== serial) return;
      error.value = toAppError(failure);
      main.value = null;
      candidates.value = [];
      ticked.value = new Set();
    } finally {
      if (listing === opId) listing = null;
      if (mine === serial) loading.value = false;
    }
  }

  /** Ticks or unticks a row; a locked worktree's branch stays unticked. */
  function toggle(name: string): void {
    const row = rows.value.find((entry) => entry.name === name);
    if (!row || row.locked) return;
    const next = new Set(ticked.value);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    choices.set(name, next.has(name));
    ticked.value = next;
  }

  /** Fetches every remote with prune, then lists again: a branch deleted there shows gone. */
  async function fetchAndPrune(): Promise<void> {
    if (fetching.value) return;
    fetching.value = true;
    try {
      await useRemotesStore().fetch(null, true);
    } finally {
      fetching.value = false;
    }
    if (isOpen.value) await list();
  }

  /**
   * Deletes the ticked branches with their worktrees, each only while its tip is the one
   * listed. The dialog closes as the deletion starts.
   */
  async function confirm(): Promise<boolean> {
    const root = repo.repo?.root;
    const going = chosen.value;
    if (!root || going.length === 0 || deleting.value) return false;
    close();
    deleting.value = true;
    const opId = newOpId("delete-branches");
    // A stop lets the branch at work finish and keeps the rest, which the toasts name.
    operations.start(opId, "operations.cleaningUp", undefined, { cancellable: true });
    try {
      const outcomes = await ipc.deleteBranches(
        root,
        going.map(({ name, tip, worktree }) => ({ name, tip, worktree })),
        opId,
      );
      settle(root, going, outcomes);
      return true;
    } catch (failure) {
      const failed = toAppError(failure);
      toasts.push({
        kind: "error",
        message: "",
        key: "cleanup.failed",
        params: { message: failed.message },
        output: failed.detail ?? failed.message,
      });
      // Branches before the failure may be gone.
      if (repo.repo?.root === root) {
        void repo.refreshRefs();
        void repo.loadWorktrees();
      }
      return false;
    } finally {
      deleting.value = false;
      operations.finish(opId);
    }
  }

  /**
   * The refs and the worktrees read again, the removed worktrees' entries flagged, the toasts:
   * what went, with the commands that bring each deleted branch back, then one for each reason a
   * branch stayed.
   */
  function settle(root: string, going: CleanupRow[], outcomes: DeleteOutcome[]): void {
    const listed = new Map(going.map((row) => [row.name, row]));
    const deleted = outcomes.filter((outcome) => outcome.deleted);
    // A worktree can go before its branch stays (a commit meanwhile, git's refusal).
    const removed = outcomes.flatMap((outcome) => {
      const path = listed.get(outcome.name)?.worktree;
      return outcome.worktreeRemoved && path ? [path] : [];
    });
    if (repo.repo?.root === root) {
      if (deleted.length > 0) arm("branches");
      for (const outcome of deleted) {
        repo.patchRefs({ kind: "delete", fullName: `refs/heads/${outcome.name}` });
      }
      if (removed.length > 0) {
        arm("worktrees");
        repo.patchWorktrees((worktrees) =>
          worktrees.filter((worktree) => !removed.some((path) => sameFolder(path, worktree.path))),
        );
      }
      void repo.refreshRefs();
      void repo.loadWorktrees();
    }
    // The removed worktrees' project members show missing.
    const index = useIndexStore();
    for (const path of removed) void index.refresh(path, false);
    if (deleted.length > 0) {
      toasts.push({
        kind: "success",
        message: "",
        key:
          removed.length === 0
            ? "cleanup.deleted"
            : removed.length === 1
              ? "cleanup.deletedWithWorktree"
              : "cleanup.deletedWithWorktrees",
        params: { n: deleted.length, m: removed.length },
        output: deleted
          .map(
            (outcome) => `git branch ${shellWord(outcome.name)} ${listed.get(outcome.name)?.tip}`,
          )
          .join("\n"),
        actionKey: "cleanup.showCommands",
        // `git branch -D` took each branch's reflog: these commands are the way back.
        sticky: true,
      });
    } else if (removed.length > 0) {
      toasts.push({
        kind: "success",
        message: "",
        key: "cleanup.removedWorktrees",
        params: { n: removed.length },
      });
    }
    for (const [reason, group] of keptByReason(outcomes)) {
      const words = group.filter((outcome) => outcome.message !== null);
      toasts.push({
        kind: "info",
        message: "",
        key: `cleanup.kept.${reason}`,
        params: { n: group.length, names: namesOf(group) },
        // git's own words, for its refusals; the sentence says the rest.
        output:
          group.length === 1
            ? (words[0]?.message ?? "")
            : words.map((outcome) => `${outcome.name}: ${outcome.message ?? ""}`).join("\n"),
      });
    }
  }

  return {
    isOpen,
    loading,
    error,
    main,
    rows,
    ticked,
    chosen,
    chosenWorktrees,
    fetching,
    deleting,
    open,
    close,
    list,
    toggle,
    fetchAndPrune,
    confirm,
  };
});
