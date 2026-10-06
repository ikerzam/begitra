// The sentences of the cleanup dialog: the body with the main branch, the empty state, the
// listing's failure, what a screen reader hears of the list's state, the confirm's label with
// its counts, a row's reason with its worktree, and a row's date. Components only render.

import { computed, type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";

import { errorText } from "@/shell/errorMessage";
import { abbreviateHome, relativeDate } from "@/shell/format";
import { useHomeDir } from "@/shell/useHomeDir";
import { useNow } from "@/shell/useNow";
import { useCleanupStore, type CleanupRow } from "@/stores/cleanup";

export interface CleanupTexts {
  /** "Branches merged into main, or gone from their remote. …" */
  body: ComputedRef<string>;
  /** "Nothing to clean up: …", or why there is no main branch to compare with. */
  empty: ComputedRef<string>;
  /** "Could not list the branches: …", the error's own sentence; empty without one. */
  failure: ComputedRef<string>;
  /** What the dialog's live region says: reading, nothing to clean up; empty otherwise. */
  status: ComputedRef<string>;
  /** "Delete 2 branches and 1 worktree"; "Delete branches" while reading or with nothing ticked. */
  confirmLabel: ComputedRef<string>;
  /** "Gone from origin, its changes in main · worktree ~/code/geo/claude-auth" */
  reason: (row: CleanupRow) => string;
  /** "3 days ago"; empty when unknown. */
  date: (row: CleanupRow) => string;
}

export function useCleanupTexts(): CleanupTexts {
  const { t } = useI18n();
  const cleanup = useCleanupStore();
  const home = useHomeDir();
  const now = useNow();

  const main = computed(() => cleanup.main ?? t("cleanup.theMainBranch"));

  const body = computed(() => t("cleanup.body", { main: main.value }));

  const empty = computed(() =>
    cleanup.main === null ? t("cleanup.noMain") : t("cleanup.empty", { main: main.value }),
  );

  const failure = computed(() => {
    if (!cleanup.error) return "";
    const text = errorText(cleanup.error);
    return t("cleanup.listFailed", { message: t(text.key, text.params) });
  });

  const status = computed(() => {
    if (cleanup.loading) return t("cleanup.loading");
    if (cleanup.error === null && cleanup.rows.length === 0) return empty.value;
    return "";
  });

  const confirmLabel = computed(() => {
    const n = cleanup.chosen.length;
    const m = cleanup.chosenWorktrees;
    if (cleanup.loading || n === 0) return t("cleanup.confirmNone");
    if (m === 0) return t("cleanup.confirm", { n }, n);
    if (m === 1) return t("cleanup.confirmWithWorktree", { n }, n);
    return t("cleanup.confirmWithWorktrees", { n, m });
  });

  /** The gone reasons' keys: with the remote named, then for a local upstream. */
  const goneKeys = {
    "gone-applied": ["cleanup.reason.goneApplied", "cleanup.reason.upstreamApplied"],
    gone: ["cleanup.reason.gone", "cleanup.reason.upstreamGone"],
    "gone-unchecked": ["cleanup.reason.goneUnchecked", "cleanup.reason.upstreamUnchecked"],
  } as const;

  function why(row: CleanupRow): string {
    if (row.reason === "merged") return t("cleanup.reason.merged", { main: main.value });
    if (row.reason === "no-commits") return t("cleanup.reason.noCommits");
    // A branch that tracks a local branch has no remote to name.
    const [named, local] = goneKeys[row.reason];
    const remote = row.remote;
    return remote === null
      ? t(local, { main: main.value })
      : t(named, { main: main.value, remote });
  }

  function reason(row: CleanupRow): string {
    if (row.worktree === null) return why(row);
    const path = abbreviateHome(row.worktree, home.value);
    return `${why(row)} · ${t(row.locked ? "cleanup.worktreeLocked" : "cleanup.worktree", { path })}`;
  }

  function date(row: CleanupRow): string {
    if (row.committedAt === null) return "";
    const ago = relativeDate(row.committedAt, now.value);
    return ago.unit === "now" ? t("dateLong.now") : t(`dateLong.${ago.unit}`, ago.n);
  }

  return { body, empty, failure, status, confirmLabel, reason, date };
}
