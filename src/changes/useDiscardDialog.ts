// The discard confirmation of the changes screen and the folder view: its title, body and
// confirm label for files, a hunk or picked lines, naming what is lost and that Undo in the
// notification brings it back, and the discard itself on the repository's changes. When no copy
// can be kept (ADR-0020), nothing is discarded and a second confirmation of its own asks again,
// saying why and that the discard is final; it ignores a press in its first moments, so a
// double click on the first one cannot confirm it. After the discard the lists take the focus
// back when nothing else holds it.
// The folder view's title also names the repository, since several can hold the same paths.
// The dialog closes when its files leave the lists.

import { computed, onScopeDispose, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { AppError } from "@/ipc/errors";
import type { FileChange } from "@/ipc/schemas";
import { hunkRange } from "@/review/diffRows";
import { baseName } from "@/shell/format";
import type { ChangesView } from "@/stores/changesModel";
import { useToastsStore } from "@/stores/toasts";

import type { DiscardRequest } from "./discard";

/** How long the second confirmation ignores a press after it opens. */
export const NO_COPY_GUARD_MS = 300;

export function useDiscardDialog(options: { refocus?: () => void } = {}) {
  const { t, n } = useI18n();
  const toasts = useToastsStore();
  const pending = shallowRef<{
    view: ChangesView;
    request: DiscardRequest;
    repository: string | null;
    /** Why no copy could be kept: the second confirmation, which discards without one. */
    noCopy: AppError | null;
  } | null>(null);
  /** When the second confirmation opened. */
  let noCopySince = 0;
  let disposed = false;
  onScopeDispose(() => {
    disposed = true;
  });

  /** Up to three names in full ("a, b and c"), then "a, b, c and N more". */
  function joinNames(names: string[]): string {
    if (names.length <= 1) return names[0] ?? "";
    if (names.length <= 3) {
      return `${names.slice(0, -1).join(", ")} ${t("changes.discardDialog.and")} ${names.at(-1)}`;
    }
    return t("changes.discardDialog.andMore", {
      names: names.slice(0, 3).join(", "),
      n: n(names.length - 3),
    });
  }

  function joinPaths(files: FileChange[]): string {
    return joinNames(files.map((file) => file.path));
  }

  /** Why no copy could be kept, as the second confirmation says it. */
  function noCopyReason(error: AppError): string {
    switch (error.code) {
      case "discard.too_large":
        return t("changes.discardDialog.noCopyTooLarge");
      case "discard.not_a_file":
        return t("changes.discardDialog.noCopyNotAFile", { path: error.detail ?? "" });
      case "discard.behind_link":
        return t("changes.discardDialog.noCopyBehindLink", { path: error.detail ?? "" });
      default:
        return t("changes.discardDialog.noCopyFailed");
    }
  }

  /**
   * The body's last sentences: Undo brings back what goes (`undoable`, a key of the kind of
   * discard, with its count), or, without a copy, why and that nothing brings it back.
   */
  function ending(undoable: string, count: number): string {
    const noCopy = pending.value?.noCopy ?? null;
    if (noCopy === null) return t(`changes.discardDialog.${undoable}`, count);
    return `${noCopyReason(noCopy)} ${t("changes.discardDialog.cannotRecover")}`;
  }

  /**
   * The dialog's title, body and confirm label for the pending discard, and the system's words
   * when a copy failed. The second confirmation has a title and a confirm of its own.
   */
  const dialog = computed(() => {
    const current = pending.value;
    if (!current) return null;
    const { request, repository, noCopy } = current;
    let title: string;
    let body: string;
    let confirm: string;
    if (request.kind === "files") {
      // "The unstaged changes to a and b are lost, and b is deleted: it is not tracked yet.";
      // untracked files alone read "b is deleted: it is not tracked yet."
      const tracked = request.files.filter((file) => file.status !== "added");
      const untracked = request.files.filter((file) => file.status === "added");
      const count = request.files.length;
      const names = joinNames(untracked.map((file) => baseName(file.path)));
      if (tracked.length === 0) {
        body = t("changes.discardDialog.bodyUntracked", { names }, untracked.length);
      } else {
        body = t("changes.discardDialog.bodyFiles", { paths: joinPaths(request.files) });
        body +=
          untracked.length > 0
            ? t("changes.discardDialog.bodyUntrackedClause", { names }, untracked.length)
            : ".";
      }
      // Tracked files lose their changes ("brings them back"); untracked ones go whole.
      body += ` ${tracked.length > 0 ? ending("undoableChanges", count) : ending("undoableFiles", count)}`;
      title =
        repository === null
          ? t("changes.discardDialog.title", { n: n(count) }, count)
          : t("changes.discardDialog.titleIn", { n: n(count), repository }, count);
      confirm = t("changes.discardDialog.confirm", { n: n(count) }, count);
    } else if (request.kind === "hunk") {
      const hunk = request.file.hunks[request.hunkIndex];
      body = `${t("changes.discardDialog.bodyHunk", {
        range: hunk ? hunkRange(hunk) : "",
        path: request.file.path,
      })} ${ending("undoableHunk", 1)}`;
      title =
        repository === null
          ? t("changes.discardDialog.hunkTitle")
          : t("changes.discardDialog.hunkTitleIn", { repository });
      confirm = t("changes.discardDialog.confirmHunk");
    } else {
      const count = request.keys.size;
      body = `${t(
        "changes.discardDialog.bodyLines",
        { n: n(count), path: request.file.path },
        count,
      )} ${ending("undoableLines", count)}`;
      title =
        repository === null
          ? t("changes.discardDialog.linesTitle", { n: n(count) }, count)
          : t("changes.discardDialog.linesTitleIn", { n: n(count), repository }, count);
      confirm = t("changes.discardDialog.confirmLines", { n: n(count) }, count);
    }
    if (noCopy === null) return { title, body, confirm, output: null };
    return {
      title:
        repository === null
          ? t("changes.discardDialog.noCopyTitle")
          : t("changes.discardDialog.noCopyTitleIn", { repository }),
      body,
      confirm: t("changes.discardDialog.noCopyConfirm"),
      // A copy that failed: the system's words under the sentence, in mono.
      output: noCopy.code === "discard.copy_failed" ? (noCopy.detail ?? noCopy.message) : null,
    };
  });

  /**
   * Asks to discard `request` in the repository `view` holds, named `repository` in the title
   * when given; nothing while a write runs.
   */
  function ask(view: ChangesView, request: DiscardRequest, repository: string | null = null): void {
    if (view.blocking || pending.value !== null) return;
    if (request.kind === "files" && request.files.length === 0) return;
    if (request.kind !== "files" && request.keys.size === 0) return;
    pending.value = { view, request, repository, noCopy: null };
  }

  /**
   * Discards what the dialog names: with a copy for Undo, or without one once the dialog asked
   * again. A copy that could not be kept discarded nothing: the dialog asks again, or, when
   * another dialog stands or the screen went, a toast says so.
   */
  async function confirm(): Promise<void> {
    const current = pending.value;
    if (!current) return;
    if (current.noCopy !== null && performance.now() - noCopySince < NO_COPY_GUARD_MS) return;
    pending.value = null;
    const { view, request } = current;
    const keepCopy = current.noCopy === null;
    const outcome =
      request.kind === "files"
        ? await view.discard(request.files, keepCopy)
        : await view.discardSelection(request.file, request.keys, request.kind, keepCopy);
    if (outcome.kind === "noCopy") {
      if (pending.value === null && !disposed) {
        noCopySince = performance.now();
        pending.value = { ...current, noCopy: outcome.error };
      } else {
        toasts.push({
          kind: "info",
          message: `${t("changes.discardDialog.nothingDiscarded")} ${noCopyReason(outcome.error)}`,
        });
      }
      return;
    }
    // The row the focus went back to left with the discard: the lists take it, unless the
    // reviewer put it elsewhere meanwhile.
    await view.settled();
    const active = document.activeElement;
    if (!disposed && (active === null || active === document.body)) options.refocus?.();
  }

  function cancel(): void {
    pending.value = null;
  }

  // A reload that took the files away closes the dialog.
  watch(
    () => pending.value?.view.unstaged.files,
    () => {
      const current = pending.value;
      if (!current || current.view.loading) return;
      const listed = new Set(current.view.unstaged.files.map((file) => file.path));
      const { request } = current;
      const paths =
        request.kind === "files" ? request.files.map((f) => f.path) : [request.file.path];
      if (!paths.every((path) => listed.has(path))) pending.value = null;
    },
  );

  return { pending, dialog, ask, confirm, cancel };
}
