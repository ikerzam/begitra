// The discard confirmation of the changes screen and the folder view: its title, body and
// confirm label for files, a hunk or picked lines, naming what is lost and that nothing can be
// recovered, and the discard itself on the repository's changes.
// The folder view's title also names the repository, since several can hold the same paths.
// The dialog closes when its files leave the lists.

import { computed, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { FileChange } from "@/ipc/schemas";
import { hunkRange } from "@/review/diffRows";
import { baseName } from "@/shell/format";
import type { ChangesView } from "@/stores/changesModel";

import type { DiscardRequest } from "./discard";

export function useDiscardDialog() {
  const { t, n } = useI18n();
  const pending = shallowRef<{
    view: ChangesView;
    request: DiscardRequest;
    repository: string | null;
  } | null>(null);

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

  /** The dialog's title, body and confirm label for the pending discard. */
  const dialog = computed(() => {
    const request = pending.value?.request;
    if (!request) return null;
    const repository = pending.value?.repository ?? null;
    if (request.kind === "files") {
      // "The unstaged changes to a and b are lost, and b is deleted: it is not tracked yet.";
      // untracked files alone read "b is deleted: it is not tracked yet."
      const tracked = request.files.filter((file) => file.status !== "added");
      const untracked = request.files.filter((file) => file.status === "added");
      const count = request.files.length;
      const names = joinNames(untracked.map((file) => baseName(file.path)));
      let body: string;
      if (tracked.length === 0) {
        body = t("changes.discardDialog.bodyUntracked", { names }, untracked.length);
      } else {
        body = t("changes.discardDialog.bodyFiles", { paths: joinPaths(request.files) });
        body +=
          untracked.length > 0
            ? t("changes.discardDialog.bodyUntrackedClause", { names }, untracked.length)
            : ".";
      }
      return {
        title:
          repository === null
            ? t("changes.discardDialog.title", { n: n(count) }, count)
            : t("changes.discardDialog.titleIn", { n: n(count), repository }, count),
        body: `${body} ${t("changes.discardDialog.cannotRecover")}`,
        confirm: t("changes.discardDialog.confirm", { n: n(count) }, count),
      };
    }
    if (request.kind === "hunk") {
      const hunk = request.file.hunks[request.hunkIndex];
      return {
        title:
          repository === null
            ? t("changes.discardDialog.hunkTitle")
            : t("changes.discardDialog.hunkTitleIn", { repository }),
        body: `${t("changes.discardDialog.bodyHunk", {
          range: hunk ? hunkRange(hunk) : "",
          path: request.file.path,
        })} ${t("changes.discardDialog.cannotRecover")}`,
        confirm: t("changes.discardDialog.confirmHunk"),
      };
    }
    const count = request.keys.size;
    return {
      title:
        repository === null
          ? t("changes.discardDialog.linesTitle", { n: n(count) }, count)
          : t("changes.discardDialog.linesTitleIn", { n: n(count), repository }, count),
      body: `${t(
        "changes.discardDialog.bodyLines",
        { n: n(count), path: request.file.path },
        count,
      )} ${t("changes.discardDialog.cannotRecover")}`,
      confirm: t("changes.discardDialog.confirmLines", { n: n(count) }, count),
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
    pending.value = { view, request, repository };
  }

  function confirm(): void {
    const current = pending.value;
    pending.value = null;
    if (!current) return;
    const { view, request } = current;
    if (request.kind === "files") void view.discard(request.files);
    else void view.applySelection("discard", request.file, request.keys);
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
