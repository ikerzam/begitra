// The words of Fetch, Pull and Push from the plans `useSync` reads: each button's accessible
// name with its count, its tooltip (where it goes, or Fetch's last fetch and its fetch in
// the background), and why it is unavailable. The top bar shows the three; the commit box its Push. A count stays while a command
// runs or the remotes are read, so a button keeps its width through a push.

import { computed } from "vue";
import { useI18n } from "vue-i18n";

import { relativeDate } from "@/shell/format";
import { useNow } from "@/shell/useNow";
import { useBackgroundFetchStore } from "@/stores/backgroundFetch";
import { useRepoStore } from "@/stores/repo";
import { intervalWords } from "@/stores/settings";

import type { SyncRefusal } from "./syncPlan";
import type { useSync } from "./useSync";

/** A button as it shows: `unavailable` is empty while it can act. */
export interface SyncButtonText {
  /** The accessible name, with the count ("Push, 2 commits to send"). */
  label: string;
  /** Where it goes, or Fetch's last fetch and the project's fetch in the background. */
  tooltip: string;
  /** The count beside the icon; 0 for none. */
  count: number;
  /** Why it cannot act now. */
  unavailable: string;
}

/** The commit box's Push: its visible text ("Push 2", "Publish") besides the button's words. */
export interface BoxPushText extends SyncButtonText {
  text: string;
}

/** Past three digits the exact number stops mattering, as `IconButton` counts. */
const COUNT_CAP = 999;

export function useSyncTexts(sync: ReturnType<typeof useSync>) {
  const { t, n } = useI18n();
  const repo = useRepoStore();
  const background = useBackgroundFetchStore();
  const now = useNow();

  const branchName = () => repo.currentBranch?.name ?? repo.repo?.currentBranch ?? "";
  const upstreamName = () => repo.currentBranch?.upstream ?? "";
  const counted = (count: number) => (count > COUNT_CAP ? `${n(COUNT_CAP)}+` : n(count));

  function refusal(reason: SyncRefusal, side: "pull" | "push"): string {
    const params = { branch: branchName(), upstream: upstreamName() };
    if (reason === "detached") {
      return t(side === "pull" ? "sync.refused.detachedPull" : "sync.refused.detachedPush");
    }
    if (reason === "upstreamGone") {
      const key = side === "pull" ? "upstreamGonePull" : "upstreamGonePush";
      return t(`sync.refused.${key}`, params);
    }
    return t(`sync.refused.${reason}`, params);
  }

  /** A refusal that passes (a command running, the remotes being read) keeps the count. */
  const passing = (reason: SyncRefusal) => reason === "busy" || reason === "readingRemotes";

  /** The open project's fetch in the background: its interval, or that it stopped here for a
   * sign-in; empty without one. */
  function inBackground(): string {
    const minutes = background.interval;
    if (minutes === null) return "";
    const root = repo.repo?.root;
    if (root && background.stoppedFor(root)) return t("backgroundFetch.stopped");
    return t(`backgroundFetch.${intervalWords(minutes)}`, { n: minutes });
  }

  /** The repository's last fetch: its remotes' own, or a later one of its repository or another
   * worktree of it, whose remote-tracking refs it shares. */
  function lastFetch(): number | null {
    const own = sync.fetchedAt.value;
    const root = repo.repo?.root;
    const family = root ? background.lastFetchOf(root) : null;
    if (own === null) return family;
    return family === null ? own : Math.max(own, family);
  }

  const fetch = computed<SyncButtonText>(() => {
    const plan = sync.fetch.value;
    const at = lastFetch();
    let when = t("remotes.neverFetched");
    if (at !== null) {
      const rel = relativeDate(at, now.value);
      const ago = rel.unit === "now" ? t("date.now") : t(`date.${rel.unit}`, { n: rel.n });
      when = t("remotes.fetchedAgo", { ago });
    }
    const scheduled = inBackground();
    return {
      label: t("sync.fetch"),
      tooltip: scheduled
        ? t("sync.fetchTipBackground", { when, background: scheduled })
        : t("sync.fetchTip", { when }),
      count: 0,
      unavailable: plan.kind === "refused" ? refusal(plan.reason, "pull") : "",
    };
  });

  const pullLabel = (behind: number) =>
    behind > 0 ? t("sync.pullCount", { n: counted(behind) }, behind) : t("sync.pull");
  const pushLabel = (ahead: number) =>
    ahead > 0 ? t("sync.pushCount", { n: counted(ahead) }, ahead) : t("sync.push");

  const pull = computed<SyncButtonText>(() => {
    const plan = sync.pull.value;
    if (plan.kind === "refused") {
      const behind = passing(plan.reason) ? (repo.currentBranch?.behind ?? 0) : 0;
      return {
        label: pullLabel(behind),
        tooltip: t("sync.pull"),
        count: behind,
        unavailable: refusal(plan.reason, "pull"),
      };
    }
    const params = { branch: plan.branch, upstream: plan.upstream };
    return {
      label: pullLabel(plan.behind),
      tooltip: t(plan.kind === "dialog" ? "sync.pullDivergedTip" : "sync.pullTip", params),
      count: plan.behind,
      unavailable: "",
    };
  });

  const push = computed<SyncButtonText>(() => {
    const plan = sync.push.value;
    if (plan.kind === "refused") {
      const ahead = passing(plan.reason) ? (repo.currentBranch?.ahead ?? 0) : 0;
      return {
        label: pushLabel(ahead),
        tooltip: t("sync.push"),
        count: ahead,
        unavailable: refusal(plan.reason, "push"),
      };
    }
    if (plan.kind === "dialog") {
      return {
        label: t("sync.publish"),
        tooltip: t("sync.pushDialogTip", { branch: plan.branch }),
        count: 0,
        unavailable: "",
      };
    }
    if (plan.publish) {
      return {
        label: t("sync.publish"),
        tooltip: t("sync.publishTip", { branch: plan.branch, remote: plan.remote }),
        count: 0,
        unavailable: "",
      };
    }
    return {
      label: pushLabel(plan.ahead),
      tooltip: t("sync.pushTip", { branch: plan.branch, upstream: upstreamName() }),
      count: plan.ahead,
      unavailable: "",
    };
  });

  /**
   * The commit box's Push: shown while the branch has commits to push or no upstream to push to,
   * unavailable while that cannot run now, and gone once there is nothing to push or no one-click
   * way to push it (a detached HEAD, no commit yet, an upstream gone from its remote).
   */
  const boxPush = computed<BoxPushText | null>(() => {
    const plan = sync.push.value;
    const words = push.value;
    const current = repo.currentBranch;
    const upstream = current?.upstream ?? null;
    if (plan.kind === "refused") {
      const pending = current !== undefined && (!upstream || (current.ahead ?? 0) > 0);
      const shows = passing(plan.reason) || plan.reason === "renamedUpstream";
      if (!pending || !shows) return null;
    }
    const publishes = plan.kind === "dialog" || (plan.kind === "push" ? plan.publish : !upstream);
    const text = publishes
      ? t("sync.publish")
      : words.count > 0
        ? t("sync.pushWithCount", { n: counted(words.count) })
        : t("sync.push");
    return { ...words, text };
  });

  return { fetch, pull, push, boxPush };
}
