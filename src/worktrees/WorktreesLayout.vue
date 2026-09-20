<script setup lang="ts">
// The worktrees dashboard,
// beside the shell's sidebar: the header with the count, "Prune" and "Add worktree",
// the error banner when a write failed, the table (or the empty state when the repository
// has no linked worktree), the confirmations and the row menu; the add dialog is the shell's,
// since ⇧⌘W opens it over any layout. The store holds every decision; this file only routes
// the rows' actions to it.

import { Eraser, Plus } from "@lucide/vue";
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import EmptyState from "@/components/EmptyState.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import { branchLanes } from "@/shell/branchLanes";
import { errorText } from "@/shell/errorMessage";
import { useExternal } from "@/shell/useExternal";
import { useRepoStore } from "@/stores/repo";
import { useWorktreesStore } from "@/stores/worktrees";

import WorktreeContextMenu from "./WorktreeContextMenu.vue";
import WorktreePrompts from "./WorktreePrompts.vue";
import WorktreeTable from "./WorktreeTable.vue";

const { t, n } = useI18n();
const repo = useRepoStore();
const worktrees = useWorktreesStore();
const external = useExternal();
const table = ref<{ focus(): Promise<void> } | null>(null);
const menu = ref<{ path: string; x: number; y: number } | null>(null);

const lanes = computed<Record<string, number>>(() => {
  const byRef = branchLanes(repo.refs);
  const entries = worktrees.rows.map((row) => [
    row.path,
    row.branch ? (byRef.get(row.branch) ?? byRef.get(`refs/heads/${row.branch}`) ?? 0) : 0,
  ]);
  return Object.fromEntries(entries) as Record<string, number>;
});
const empty = computed(
  () => !worktrees.loading && worktrees.rows.length > 0 && worktrees.linked.length === 0,
);
const menuRow = computed(() => worktrees.rows.find((row) => row.path === menu.value?.path) ?? null);
/** The banner: the missing-folder sentence with "Prune worktrees", or git's message. */
const banner = computed(() => {
  const error = worktrees.error;
  if (!error) return null;
  const path = worktrees.errorPath;
  const missing =
    error.code === "worktree.missing_folder" ||
    (path !== null && worktrees.rows.some((row) => row.path === path && row.prunable));
  if (missing) {
    return {
      message: t("worktrees.missingFolder", { path: path ?? "" }),
      output: error.detail ?? error.message,
      action: t("worktrees.pruneAction"),
      prune: true,
    };
  }
  const text = errorText(error);
  return {
    message: t(text.key, text.params),
    output: error.detail ?? "",
    action: "",
    prune: false,
  };
});

/** Terminal and editor never open a folder that is gone: the banner says so instead. */
function withFolder(path: string, open: (path: string) => Promise<boolean>): void {
  const row = worktrees.rows.find((entry) => entry.path === path);
  if (row?.prunable) {
    worktrees.reportMissing(path);
    return;
  }
  void open(path);
}

function openMenu(path: string, x: number, y: number): void {
  worktrees.select(path);
  menu.value = { path, x, y };
}

function closeMenu(): void {
  menu.value = null;
  void nextTick(() => table.value?.focus());
}

function withMenuRow(action: (path: string) => void): void {
  const path = menu.value?.path;
  menu.value = null;
  if (path) action(path);
}

defineExpose({ focusRows: () => void table.value?.focus() });
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1" data-testid="worktrees-layout">
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <header
        class="worktrees-header flex shrink-0 items-center gap-3 border-b border-line px-3"
        data-testid="worktrees-header"
      >
        <h2 class="text-md font-medium text-fg">{{ t("worktrees.title") }}</h2>
        <span
          v-if="!worktrees.loading || worktrees.rows.length > 0"
          class="text-sm text-fg-muted"
          data-testid="worktrees-count"
        >
          {{ n(worktrees.linked.length) }}
        </span>
        <span class="flex-1" />
        <Button
          variant="ghost"
          :icon="Eraser"
          :disabled="worktrees.prunable.length === 0"
          data-testid="worktrees-prune"
          @click="worktrees.askPrune()"
        >
          {{ t("worktrees.prune.action") }}
        </Button>
        <Button
          variant="primary"
          :icon="Plus"
          data-testid="worktrees-add"
          @click="worktrees.openAdd()"
        >
          {{ t("worktrees.add.action") }}
        </Button>
      </header>
      <div v-if="banner" class="px-3 pt-3" data-testid="worktrees-error">
        <ErrorBanner
          :message="banner.message"
          :output="banner.output"
          :action="banner.action"
          :open="banner.prune"
          @action="banner.prune ? worktrees.askPrune() : undefined"
        />
      </div>
      <EmptyState
        v-if="empty"
        class="flex-1"
        :message="t('worktrees.empty')"
        data-testid="worktrees-empty"
      >
        <Button variant="secondary" @click="worktrees.openAdd()">
          {{ t("worktrees.add.action") }}
        </Button>
      </EmptyState>
      <WorktreeTable
        v-else
        ref="table"
        :rows="worktrees.rows"
        :lanes="lanes"
        :selected-path="worktrees.selectedPath"
        :loading="worktrees.loading"
        @select="worktrees.select"
        @activate="(path) => void worktrees.openAsContext(path)"
        @compare="(path) => void worktrees.compareWithMain(path)"
        @terminal="(path) => withFolder(path, external.openTerminal)"
        @editor="(path) => withFolder(path, external.openEditor)"
        @remove="worktrees.askRemove"
        @menu="openMenu"
      />
    </div>
    <WorktreePrompts v-if="worktrees.prompt" :prompt="worktrees.prompt" />
    <WorktreeContextMenu
      v-if="menu && menuRow"
      :row="menuRow"
      :x="menu.x"
      :y="menu.y"
      @compare="withMenuRow((path) => void worktrees.compareWithMain(path))"
      @open-terminal="withMenuRow((path) => withFolder(path, external.openTerminal))"
      @open-editor="withMenuRow((path) => withFolder(path, external.openEditor))"
      @lock="withMenuRow((path) => worktrees.askLock(path))"
      @unlock="withMenuRow((path) => void worktrees.unlock(path))"
      @remove="withMenuRow((path) => worktrees.askRemove(path))"
      @close="closeMenu"
    />
  </div>
</template>

<style scoped>
/* 48px tall, like the compare header: the 28px controls and their
   focus ring need the room. Off the spacing scale. */
.worktrees-header {
  height: 48px;
}
</style>
