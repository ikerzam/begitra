<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import AheadBehind from "@/components/AheadBehind.vue";
import Kbd from "@/components/Kbd.vue";
import LaneDot from "@/components/LaneDot.vue";
import Progress from "@/components/Progress.vue";
import { shortcutRegistry } from "@/shortcuts/registry";
import { useOperationsStore } from "@/stores/operations";
import { useRepoStore } from "@/stores/repo";
import { useShellStore } from "@/stores/shell";

import { baseName, shortHash } from "./format";

const { t } = useI18n();
const repo = useRepoStore();
const shell = useShellStore();
const operations = useOperationsStore();

const path = computed(() => repo.repo?.root ?? "");
const branch = computed(() => repo.currentBranch);
const repoName = computed(() => {
  const state = repo.state;
  if (state.kind === "ready") return baseName(path.value);
  if (state.kind === "opening" || state.kind === "error") return baseName(state.path);
  return "";
});

const branchLabel = computed(() => {
  if (repo.repo?.detached) return t("statusBar.detached");
  return repo.repo?.currentBranch ?? "";
});

const operationText = computed(() => {
  const current = operations.current;
  if (!current) return "";
  return t(current.label, {
    name: repoName.value,
    hash: repo.detail ? shortHash(repo.detail.hash) : "",
  });
});

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
      <span class="text-fg-secondary">{{ t("statusBar.noRepositories") }}</span>
    </template>
    <template v-else>
      <span
        v-if="repo.state.kind === 'ready' && branchLabel"
        class="flex items-center gap-2 text-fg"
        data-testid="status-branch"
      >
        <LaneDot :lane="1" />
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
      <span
        v-if="operations.current && repo.state.kind !== 'error'"
        class="flex items-center gap-2 text-fg-secondary"
        data-testid="status-operation"
      >
        {{ operationText }}
        <Progress class="status-progress" indeterminate :label="operationText" />
      </span>
    </template>
    <span class="ml-auto flex items-center gap-4 text-fg-muted" data-testid="status-hints">
      <span v-for="hint in hints" :key="hint.label" class="flex items-center gap-1">
        <Kbd :keys="hint.keys" />
        {{ hint.label }}
      </span>
    </span>
  </footer>
</template>

<style scoped>
/* The inline progress bar is 112px wide; not on the spacing scale. */
.status-progress {
  width: 112px;
}
</style>
