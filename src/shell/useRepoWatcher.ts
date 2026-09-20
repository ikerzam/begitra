// Keeps the open repository current: starts the filesystem watcher when a repository opens
// (a watcher that cannot start becomes a toast: the repository stays open without change
// detection), and on `repo:changed` refreshes the refs when they changed, the worktree list
// when a worktree came or went, and the index entry on any change. The backend debounces, so
// nothing is coalesced here.

import type { UnlistenFn } from "@tauri-apps/api/event";
import { onBeforeUnmount, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";

import { watchRepository } from "@/ipc/commands";
import { toAppError } from "@/ipc/errors";
import { onRepoChanged } from "@/ipc/events";
import type { RepoChanged } from "@/ipc/schemas";
import { useIndexStore } from "@/stores/index";
import { useRepoStore } from "@/stores/repo";
import { useReviewStore } from "@/stores/review";
import { useToastsStore } from "@/stores/toasts";

import { errorText } from "./errorMessage";

export function useRepoWatcher(): void {
  const { t } = useI18n();
  const repo = useRepoStore();
  const index = useIndexStore();
  const toasts = useToastsStore();
  const review = useReviewStore();
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
    if (change.kinds.includes("refs")) void repo.refreshRefs();
    if (change.kinds.includes("worktrees")) void repo.loadWorktrees();
    review.onRepoChanged(change.kinds);
    void index.refresh(root);
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
