// Keeps the open repository current: starts the filesystem watcher when a repository opens
// (a watcher that cannot start becomes a toast: the repository stays open without change
// detection), and on `repo:changed` refreshes the refs when they or the worktrees changed (a
// branch's worktree marker follows the worktrees; the repo store lists the history again when
// the listing shows other tips than the history), the worktree list with either (a commit or a
// switch moves a worktree's HEAD), the remotes with the refs (the configuration counts as
// refs), and the index entry on any change. The backend debounces, so nothing is coalesced here.

import type { UnlistenFn } from "@tauri-apps/api/event";
import { onBeforeUnmount, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";

import { watchRepository } from "@/ipc/commands";
import { toAppError } from "@/ipc/errors";
import { onRepoChanged } from "@/ipc/events";
import type { RepoChanged } from "@/ipc/schemas";
import { useIndexStore } from "@/stores/index";
import { useRepoStore } from "@/stores/repo";
import { useChangesStore } from "@/stores/changes";
import { useCompareStore } from "@/stores/compare";
import { useConflictBlocksStore } from "@/stores/conflictBlocks";
import { useRemotesStore } from "@/stores/remotes";
import { useReviewStore } from "@/stores/review";
import { useSequencerStore } from "@/stores/sequencer";
import { useToastsStore } from "@/stores/toasts";
import { useWorktreesStore } from "@/stores/worktrees";

import { errorText } from "./errorMessage";

export function useRepoWatcher(): void {
  const { t } = useI18n();
  const repo = useRepoStore();
  const index = useIndexStore();
  const toasts = useToastsStore();
  const review = useReviewStore();
  const compare = useCompareStore();
  const worktrees = useWorktreesStore();
  const changes = useChangesStore();
  const sequencer = useSequencerStore();
  const conflictBlocks = useConflictBlocksStore();
  const remotes = useRemotesStore();
  let unlisten: UnlistenFn | undefined;
  let disposed = false;

  async function startWatching(root: string): Promise<void> {
    try {
      await watchRepository(root);
    } catch (error) {
      if (repo.repo?.root !== root) return;
      const failed = toAppError(error);
      const text = errorText(failed, root);
      toasts.push({ kind: "info", message: t(text.key, text.params), output: failed.detail });
    }
  }

  function onChange(change: RepoChanged): void {
    const root = repo.repo?.root;
    if (!root || change.repo !== root) return;
    // A tip moved outside the app (a terminal, an agent): the graph follows, selection kept.
    if (change.kinds.includes("refs") || change.kinds.includes("worktrees")) {
      void repo.refreshRefs();
    }
    review.onRepoChanged(change);
    compare.onRepoChanged(change.kinds);
    void worktrees.onRepoChanged(change.kinds);
    changes.onRepoChanged(change);
    sequencer.onRepoChanged(change);
    conflictBlocks.onRepoChanged(change);
    remotes.onRepoChanged(change.kinds);
    // Branch, upstream and tip; the dirty flag waits until the repository is closed.
    if (change.kinds.includes("refs") || change.kinds.includes("worktrees")) {
      void index.refresh(root, false);
    }
  }

  watch(
    () => repo.repo?.root,
    (root) => {
      if (root) void startWatching(root);
    },
    { immediate: true },
  );

  onMounted(async () => {
    let stop: UnlistenFn;
    try {
      stop = await onRepoChanged(onChange);
    } catch {
      // Outside Tauri there is nothing to listen to.
      return;
    }
    if (disposed) stop();
    else unlisten = stop;
  });

  onBeforeUnmount(() => {
    disposed = true;
    unlisten?.();
    unlisten = undefined;
  });
}
