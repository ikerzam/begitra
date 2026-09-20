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
import { targetLabel, useReviewStore } from "@/stores/review";
import { useShellStore } from "@/stores/shell";

import { branchLanes } from "./branchLanes";
import { abbreviateHome, baseName, shortHash } from "./format";
import { useHomeDir } from "./useHomeDir";

const { t } = useI18n();
const repo = useRepoStore();
const shell = useShellStore();
const index = useIndexStore();
const operations = useOperationsStore();
const review = useReviewStore();
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
  return t(current.label, {
    name: repoName.value,
    hash: repo.detail ? shortHash(repo.detail.hash) : "",
    folder: scanFolder.value,
    target: target ? targetLabel(target) || t(`review.target.${target.kind}`) : "",
  }).trim();
});

/** Review focus's error state: the diff of the target failed, in `--danger`. */
const diffFailed = computed(() => {
  const error = review.changeSet?.error;
  if (!error || shell.layoutMode !== "review") return "";
  return error.code === "diff.blob_missing"
    ? t("statusBar.diffFailed", { n: 1 }, 1)
    : t("statusBar.diffFailedAll");
});

/** With no repository open: how many the index holds, or that there are none. */
const indexText = computed(() =>
  index.counts.repositories > 0
    ? t("statusBar.repositories", index.counts.repositories)
    : t("statusBar.noRepositories"),
);

const hints = computed(() => {
  const registry = shortcutRegistry();
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
  return [
    { keys: "j/k", label: t("statusBar.commits") },
    { keys: "↵", label: t("statusBar.review") },
    { keys: registry.hint("palette"), label: t("statusBar.commands") },
  ];
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
    <span v-if="historyStopped" class="text-danger" data-testid="status-history-stopped">
      {{ historyStopped }}
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
      class="flex items-center gap-2 text-fg-secondary"
      data-testid="status-operation"
    >
      {{ operationText }}
      <Progress class="status-progress" indeterminate :label="operationText" />
    </span>
    <span class="ml-auto flex items-center gap-4 text-fg-muted" data-testid="status-hints">
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
