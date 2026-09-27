<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import AheadBehind from "@/components/AheadBehind.vue";
import Kbd from "@/components/Kbd.vue";
import LaneDot from "@/components/LaneDot.vue";
import Progress from "@/components/Progress.vue";
import { shortcutRegistry } from "@/shortcuts/registry";
import { useIndexStore } from "@/stores/index";
import { useOperationsStore } from "@/stores/operations";
import { useRepoStore } from "@/stores/repo";
import { useChangesStore } from "@/stores/changes";
import { useFolderStore } from "@/stores/folder";
import { useSequencerStore } from "@/stores/sequencer";
import { useCompareStore } from "@/stores/compare";
import { targetLabel, useReviewStore } from "@/stores/review";
import { useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";

import { branchLanes } from "./branchLanes";
import { abbreviateHome, baseName, shortHash } from "./format";
import { useHomeDir } from "./useHomeDir";

const { t } = useI18n();
const repo = useRepoStore();
const shell = useShellStore();
const settings = useSettingsStore();
const index = useIndexStore();
const operations = useOperationsStore();
const review = useReviewStore();
const compare = useCompareStore();
const changes = useChangesStore();
const folderView = useFolderStore();
const sequencer = useSequencerStore();
const home = useHomeDir();

/** The open repository, or the folder being opened or that failed to open. */
const path = computed(() => {
  const state = repo.state;
  if (state.kind === "ready") return repo.repo?.root ?? "";
  if (state.kind === "opening" || state.kind === "error") return state.path;
  return "";
});
const branch = computed(() => repo.currentBranch);
const branchLane = computed(() => {
  const current = branch.value;
  return current ? (branchLanes(repo.refs).get(current.fullName) ?? 1) : 1;
});
const repoName = computed(() => baseName(path.value));

const branchLabel = computed(() => {
  if (repo.repo?.detached) return t("statusBar.detached");
  return repo.repo?.currentBranch ?? "";
});

/** The folder the scan is walking, with the home folder as `~` ("Scanning ~/code"). */
const scanFolder = computed(() => {
  const scan = index.scan;
  return scan.kind === "scanning" && scan.current ? abbreviateHome(scan.current, home.value) : "";
});

/** The graph's error state: where the history stopped, in `--danger`, with no progress bar. */
const historyStopped = computed(() => {
  if (!repo.walkError) return "";
  const last = repo.commits.at(-1);
  return last
    ? t("statusBar.historyStopped", { hash: shortHash(last.hash) })
    : t("statusBar.historyStoppedEarly");
});

const operationText = computed(() => {
  const current = operations.current;
  if (!current) return "";
  const target = review.target;
  // The total picks a label's plural form ("Reading 1 repository"); a label without one
  // ignores it.
  const text = t(
    current.label,
    {
      name: repoName.value,
      hash: repo.detail ? shortHash(repo.detail.hash) : "",
      folder: scanFolder.value,
      target: target ? targetLabel(target) || t(`review.target.${target.kind}`) : "",
      a: compare.endpoints?.a.label ?? "",
      b: compare.endpoints?.b.label ?? "",
      ...current.params,
    },
    current.total ?? 1,
  ).trim();
  // A network command's latest progress line follows its label.
  return current.detail ? `${text} · ${current.detail}` : text;
});

/** The operation stopped on conflicts, for the changes screen's slot. */
const stoppedText = computed(() => {
  if (!sequencer.inProgress || shell.layoutMode !== "changes") return "";
  const operation = t(`sequencer.operations.${sequencer.operation}`);
  const n = sequencer.conflictCount;
  return n > 0
    ? t("statusBar.operationInProgress", { operation, n }, n)
    : t("statusBar.operationClean", { operation });
});

/** The project view's error state: the index it reads could not be read, in `--danger`. */
const indexFailed = computed(() =>
  (shell.layoutMode === "project" || shell.layoutMode === "folder") && index.loadError
    ? t("statusBar.indexFailed")
    : "",
);

/** Review focus's error state: the diff of the target failed, in `--danger`. */
const diffFailed = computed(() => {
  const error = review.changeSet?.error;
  if (!error || shell.layoutMode !== "review") return "";
  return error.code === "diff.blob_missing"
    ? t("statusBar.diffFailed", { n: 1 }, 1)
    : t("statusBar.diffFailedAll");
});

/** Changes: the counts, the clean tree, the loading, or the write that failed (in danger). */
const changesText = computed<{ text: string; failed: boolean }>(() => {
  if (shell.layoutMode !== "changes" || repo.state.kind !== "ready") {
    return { text: "", failed: false };
  }
  const failed = changes.failed;
  if (failed) {
    const text =
      failed.kind === "commit"
        ? t("statusBar.commitFailed")
        : t(
            "statusBar.writeFailed",
            { action: t(`statusBar.writeKinds.${failed.kind}`), n: failed.files },
            failed.files,
          );
    return { text, failed: true };
  }
  if (changes.error) return { text: t("statusBar.changesFailed"), failed: true };
  if (!changes.loaded || (changes.loading && changes.unstagedCount + changes.stagedCount === 0)) {
    return { text: t("statusBar.loadingChanges"), failed: false };
  }
  if (changes.isEmpty) return { text: t("statusBar.workingTreeClean"), failed: false };
  const counts = t("statusBar.changes", {
    unstaged: changes.unstagedCount,
    staged: changes.stagedCount,
  });
  const head = repo.currentBranch?.target ?? repo.commits[0]?.hash;
  const amending =
    changes.draft.amend && head ? ` · ${t("statusBar.amending", { hash: shortHash(head) })}` : "";
  return { text: `${counts}${amending}`, failed: false };
});

/** With no repository open: how many the index holds, or that there are none. */
const indexText = computed(() =>
  index.counts.repositories > 0
    ? t("statusBar.repositories", index.counts.repositories)
    : t("statusBar.noRepositories"),
);

const hints = computed(() => {
  const registry = shortcutRegistry();
  // While a network command runs, the bar keeps only its cancel and the palette.
  if (operations.current?.cancellable) {
    return [{ keys: registry.hint("palette"), label: t("statusBar.commands") }];
  }
  if (
    (shell.layoutMode === "folder" || shell.layoutMode === "project") &&
    settings.values.projectTab === "overview"
  ) {
    return [
      { keys: "j/k", label: t("statusBar.repositoryRows") },
      { keys: t("statusBar.spaceKey"), label: t("statusBar.select") },
      { keys: "↵", label: t("statusBar.open") },
      { keys: registry.hint("palette"), label: t("statusBar.commands") },
    ];
  }
  if (shell.layoutMode === "folder" || shell.layoutMode === "project") {
    // With nothing to stage (the scan, the first reads, no change), the way back and the
    // palette, as on the changes screen.
    if (folderView.state !== "changes") {
      return [
        { keys: registry.hint("graph-focus"), label: t("statusBar.graph") },
        { keys: registry.hint("palette"), label: t("statusBar.commands") },
      ];
    }
    return [
      { keys: "j/k", label: t("statusBar.files") },
      { keys: registry.hint("stage-file"), label: t("statusBar.stage") },
      {
        keys: registry.hint("commit"),
        label: folderView.active?.view.draft.amend ? t("statusBar.amend") : t("statusBar.commit"),
      },
    ];
  }
  if (repo.state.kind !== "ready") {
    return [
      { keys: "↵", label: t("statusBar.open") },
      { keys: registry.hint("palette"), label: t("statusBar.commands") },
    ];
  }
  if (shell.layoutMode === "review") {
    return [
      { keys: "j/k", label: t("statusBar.files") },
      { keys: "n/p", label: t("statusBar.hunks") },
      { keys: "r", label: t("statusBar.markReviewed") },
    ];
  }
  if (shell.layoutMode === "compare") {
    return [
      { keys: "j/k", label: t("statusBar.commits") },
      { keys: "↵", label: t("statusBar.review") },
      { keys: registry.hint("palette"), label: t("statusBar.commands") },
    ];
  }
  if (shell.layoutMode === "worktrees") {
    return [
      { keys: "j/k", label: t("statusBar.worktrees") },
      { keys: "↵", label: t("statusBar.open") },
      { keys: registry.hint("palette"), label: t("statusBar.commands") },
    ];
  }
  if (shell.layoutMode === "settings") {
    return [
      { keys: "j/k", label: t("statusBar.fields") },
      { keys: "↵", label: t("statusBar.edit") },
      { keys: registry.hint("palette"), label: t("statusBar.commands") },
    ];
  }
  if (shell.layoutMode === "changes") {
    if (sequencer.inProgress) {
      return [
        { keys: "j/k", label: t("statusBar.files") },
        { keys: registry.hint("mark-resolved"), label: t("statusBar.markResolved") },
        { keys: registry.hint("palette"), label: t("statusBar.commands") },
      ];
    }
    // A clean tree (or one still loading) has nothing to stage: the way back to the graph
    // and the palette instead.
    if (
      changes.isEmpty ||
      !changes.loaded ||
      (changes.loading && changes.unstagedCount + changes.stagedCount === 0)
    ) {
      return [
        { keys: registry.hint("graph-focus"), label: t("statusBar.graph") },
        { keys: registry.hint("palette"), label: t("statusBar.commands") },
      ];
    }
    return [
      { keys: "j/k", label: t("statusBar.files") },
      { keys: registry.hint("stage-file"), label: t("statusBar.stage") },
      {
        keys: registry.hint("commit"),
        label: changes.draft.amend ? t("statusBar.amend") : t("statusBar.commit"),
      },
    ];
  }
  return [
    { keys: "j/k", label: t("statusBar.commits") },
    { keys: "↵", label: t("statusBar.review") },
    { keys: registry.hint("palette"), label: t("statusBar.commands") },
  ];
});

/** While a network command runs, Escape cancels it; the hint says so. */
const cancelHint = computed(() => {
  const current = operations.current;
  if (!current?.cancellable) return null;
  const what = current.label.includes("push")
    ? "push"
    : current.label.includes("pull")
      ? "pull"
      : "fetch";
  return {
    keys: "esc",
    label: t("statusBar.cancelOperation", { what: t(`statusBar.network.${what}`) }),
  };
});
</script>

<template>
  <footer
    class="flex h-bar-status shrink-0 items-center gap-4 border-t border-line px-3 text-sm whitespace-nowrap"
    data-testid="status-bar"
  >
    <template v-if="repo.state.kind === 'empty'">
      <span class="text-fg-secondary" data-testid="status-index">{{ indexText }}</span>
    </template>
    <template v-else>
      <span
        v-if="repo.state.kind === 'ready' && branchLabel"
        class="flex items-center gap-2 text-fg"
        data-testid="status-branch"
      >
        <LaneDot :lane="branchLane" />
        {{ branchLabel }}
      </span>
      <span v-else class="text-fg">{{ repoName }}</span>
      <AheadBehind
        v-if="branch?.upstream"
        :ahead="branch.ahead ?? 0"
        :behind="branch.behind ?? 0"
      />
      <span v-if="path" class="font-mono text-mono-sm text-fg-secondary" data-testid="status-path">
        {{ path }}
      </span>
    </template>
    <span v-if="stoppedText" class="text-fg-muted" data-testid="status-stopped">
      {{ stoppedText }}
    </span>
    <span
      v-else-if="changesText.text"
      :class="changesText.failed ? 'text-danger' : 'text-fg-muted'"
      data-testid="status-changes"
    >
      {{ changesText.text }}
    </span>
    <span v-if="historyStopped" class="text-danger" data-testid="status-history-stopped">
      {{ historyStopped }}
    </span>
    <span v-else-if="indexFailed" class="text-danger" data-testid="status-index-failed">
      {{ indexFailed }}
    </span>
    <span v-else-if="diffFailed" class="text-danger" data-testid="status-diff-failed">
      {{ diffFailed }}
    </span>
    <span
      v-else-if="review.currentSymbol && shell.layoutMode === 'review'"
      class="text-fg-secondary"
      data-testid="status-symbol"
    >
      {{ t("statusBar.symbol", { name: review.currentSymbol }) }}
    </span>
    <span
      v-else-if="operations.current && repo.state.kind !== 'error'"
      class="flex items-center gap-2 text-fg-muted"
      data-testid="status-operation"
    >
      {{ operationText }}
      <Progress
        class="status-progress"
        :indeterminate="operations.currentFraction === undefined"
        :value="(operations.currentFraction ?? 0) * 100"
        :label="operationText"
      />
    </span>
    <span class="ml-auto flex items-center gap-4 text-fg-muted" data-testid="status-hints">
      <span v-if="cancelHint" class="flex items-center gap-2" data-testid="status-cancel">
        <Kbd :keys="cancelHint.keys" />
        {{ cancelHint.label }}
      </span>
      <span v-for="hint in hints" :key="hint.label" class="flex items-center gap-2">
        <Kbd :keys="hint.keys" />
        {{ hint.label }}
      </span>
    </span>
  </footer>
</template>

<style scoped>
/* The inline progress bar is 80px wide; not on the spacing scale. */
.status-progress {
  width: 80px;
}
</style>
