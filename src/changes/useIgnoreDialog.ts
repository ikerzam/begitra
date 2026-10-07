// The ignore dialog of the changes screen and the folder view: for an untracked file, which
// rule (the file, its extension, its folder) and where (`.gitignore`, `.git/info/exclude`),
// the line it will add, and the write through the repository's changes. A toast says what
// was written where, or which rule still keeps the file. The dialog closes when its file
// leaves the lists; once the lists are read again without the file's row, `refocus` gives the
// focus back to them.

import { computed, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { FileChange, IgnoreOutcome, IgnorePlace, IgnoreRule } from "@/ipc/schemas";
import { baseName } from "@/shell/format";
import type { ChangesView } from "@/stores/changesModel";
import { useToastsStore } from "@/stores/toasts";

import { ignoreLine, ignoreRules } from "./ignore";

/** The file a place names, as the dialog and the toasts say it. */
export function placeName(place: IgnorePlace): string {
  return place === "gitignore" ? ".gitignore" : ".git/info/exclude";
}

export function useIgnoreDialog(options: { refocus?: () => void } = {}) {
  const { t, n } = useI18n();
  const toasts = useToastsStore();
  const pending = shallowRef<{
    view: ChangesView;
    file: FileChange;
    /** The folder view names the repository, since several can hold the same paths. */
    repository: string | null;
  } | null>(null);
  const rule = ref<IgnoreRule>("file");
  const place = ref<IgnorePlace>("gitignore");

  const path = computed(() => pending.value?.file.path ?? "");
  const rules = computed(() => (pending.value ? ignoreRules(path.value) : []));
  const line = computed(() => ignoreLine(path.value, rule.value) ?? "");

  /**
   * Asks about `file`, an untracked file (or folder) of `view`'s unstaged list, in the
   * repository named `repository` when given; nothing while a write runs.
   */
  function ask(view: ChangesView, file: FileChange, repository: string | null = null): void {
    if (view.blocking || pending.value !== null || file.status !== "added") return;
    rule.value = "file";
    place.value = "gitignore";
    pending.value = { view, file, repository };
  }

  /** The toast of an outcome: what was written where, and what still keeps the file. */
  function report(
    outcome: IgnoreOutcome,
    where: IgnorePlace,
    file: FileChange,
    repository: string | null,
  ): void {
    const params = {
      line: outcome.line,
      file: repository === null ? placeName(where) : `${repository}/${placeName(where)}`,
      name: baseName(file.path),
    };
    const start = outcome.written ? "added" : "already";
    if (outcome.ignored) {
      toasts.push({ kind: "success", message: t(`changes.ignoreToast.${start}`, params) });
      return;
    }
    const kept = outcome.keptBy;
    const message = kept
      ? t(`changes.ignoreToast.${start}Kept`, {
          ...params,
          pattern: kept.pattern,
          source: kept.source,
          at: n(kept.line),
        })
      : t(`changes.ignoreToast.${start}NotIgnored`, params);
    toasts.push({ kind: "error", message });
  }

  async function confirm(): Promise<void> {
    const current = pending.value;
    pending.value = null;
    if (!current) return;
    const where = place.value;
    const outcome = await current.view.ignore(current.file.path, rule.value, where);
    if (outcome) report(outcome, where, current.file, current.repository);
    // The row the focus went back to left with the reload: the lists take it, unless the
    // reviewer put it elsewhere meanwhile.
    await current.view.settled();
    const active = document.activeElement;
    if (active === null || active === document.body) options.refocus?.();
  }

  function cancel(): void {
    pending.value = null;
  }

  // A reload that took the file away closes the dialog.
  watch(
    () => pending.value?.view.unstaged.files,
    () => {
      const current = pending.value;
      if (!current || current.view.loading) return;
      if (!current.view.unstaged.files.some((file) => file.path === current.file.path)) {
        pending.value = null;
      }
    },
  );

  const repository = computed(() => pending.value?.repository ?? null);

  return { pending, path, repository, rule, place, rules, line, ask, confirm, cancel };
}
