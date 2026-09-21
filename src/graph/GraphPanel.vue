<script setup lang="ts">
// The graph area of graph focus: the filter bar, the commit rows with their lanes, the hover
// card and the context menu, and its empty and error states (no commit to show, a history that
// stopped at an error, a repository that could not be opened).

import { Terminal } from "@lucide/vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import BranchContextMenu from "@/branches/BranchContextMenu.vue";
import { useBranchActions, type BranchAction } from "@/branches/useBranchActions";
import Button from "@/components/Button.vue";
import EmptyState from "@/components/EmptyState.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import type { CommitNode, Ref as GitRef } from "@/ipc/schemas";
import { errorText } from "@/shell/errorMessage";
import { shortHash } from "@/shell/format";
import { useGraphStore } from "@/stores/graph";
import { useRepoStore } from "@/stores/repo";
import { useToastsStore } from "@/stores/toasts";

import CommitContextMenu from "./CommitContextMenu.vue";
import CommitRows from "./CommitRows.vue";
import FilterBar from "./FilterBar.vue";
import HoverCard from "./HoverCard.vue";
import { useCommitActions } from "./useCommitActions";
import { useHoverCard } from "./useHoverCard";

const emit = defineEmits<{ activate: [index: number]; removeFromList: [] }>();

const { t } = useI18n();
const repo = useRepoStore();
const graph = useGraphStore();
const toasts = useToastsStore();
const actions = useCommitActions();
const branchActions = useBranchActions();
const hover = useHoverCard();
const rows = ref<{ focus(): void } | null>(null);

const menu = ref<{ index: number; x: number; y: number } | null>(null);
/** The menu of a ref badge: the branch actions of the sidebar's rows, from the graph. */
const refMenu = ref<{ ref: GitRef; x: number; y: number } | null>(null);
const currentName = computed(() => repo.currentBranch?.name ?? null);
const menuCommit = computed(() => (menu.value ? repo.commits[menu.value.index] : undefined));
const hoverCommit = computed(() =>
  hover.target.value ? repo.commits[hover.target.value.index] : undefined,
);

function commitAt(index: number): CommitNode | undefined {
  return repo.commits[index];
}

function openMenu(index: number, x: number, y: number): void {
  hover.hide();
  menu.value = { index, x, y };
}

function closeMenu(): void {
  menu.value = null;
  rows.value?.focus();
}

function openRefMenu(_index: number, target: GitRef, x: number, y: number): void {
  hover.hide();
  menu.value = null;
  refMenu.value = { ref: target, x, y };
}

function closeRefMenu(): void {
  refMenu.value = null;
  rows.value?.focus();
}

/** The badge menu's choice: closed first, then run with its ref. */
function chooseRefAction(kind: BranchAction): void {
  const target = refMenu.value?.ref;
  refMenu.value = null;
  if (target) branchActions.run(kind, target);
}

function withMenuCommit(action: (commit: CommitNode) => unknown): void {
  const commit = menuCommit.value;
  if (commit) void action(commit);
}

function selectParent(hash: string): void {
  const index = repo.commits.findIndex((c) => c.hash === hash);
  if (index >= 0) repo.select(index);
  else toasts.push({ kind: "info", message: t("detail.parentNotLoaded") });
  hover.hide();
}

watch(
  () => repo.selectedIndex,
  () => hover.hide(),
);

const errorMessage = computed(() => {
  const state = repo.state;
  if (state.kind !== "error") return "";
  const text = errorText(state.error, state.path);
  return t(text.key, text.params);
});

/** The banner of a history that stopped at an error: where it stopped and what to do. */
const walkError = computed(() => {
  const error = repo.walkError;
  if (!error) return null;
  const last = repo.commits.at(-1);
  if (error.code === "repo.corrupt_object") {
    return {
      message: last
        ? t("graph.corruptPast", { hash: shortHash(last.hash) })
        : t("graph.corruptStart"),
      action: t("palette.commandsById.open-terminal"),
      corrupt: true,
      output: error.detail ?? error.message,
    };
  }
  const text = errorText(error);
  return {
    message: t("graph.historyFailed", { message: t(text.key, text.params) }),
    action: t("home.retry"),
    corrupt: false,
    output: error.detail ?? "",
  };
});

function onWalkErrorAction(): void {
  if (walkError.value?.corrupt) void actions.openTerminal();
  else repo.restartWalk(repo.walkScope, repo.walkFilter);
}

const showEmpty = computed(
  () =>
    repo.state.kind === "ready" &&
    !repo.streaming &&
    repo.commits.length === 0 &&
    repo.walkError === null,
);

defineExpose({ focus: () => rows.value?.focus() });
</script>

<template>
  <section
    class="flex min-w-0 flex-1 flex-col"
    data-testid="graph-panel"
    @keydown.escape="hover.hide()"
  >
    <!-- A failed open has no filter bar: the banner takes the whole area. -->
    <FilterBar v-if="repo.state.kind !== 'error'" />

    <div v-if="repo.state.kind === 'error'" class="p-5" data-testid="graph-error">
      <ErrorBanner
        :message="errorMessage"
        :output="repo.state.error.detail"
        :action="t('graph.removeFromList')"
        @action="emit('removeFromList')"
      />
    </div>

    <template v-else>
      <EmptyState
        v-if="showEmpty && graph.isActive"
        :message="t('graph.noMatches')"
        data-testid="graph-empty"
      >
        <Button variant="secondary" @click="graph.clear()">{{ t("graph.clearFilters") }}</Button>
      </EmptyState>
      <EmptyState v-else-if="showEmpty" :message="t('graph.noCommits')" data-testid="graph-empty" />
      <CommitRows
        v-else
        ref="rows"
        :commits="repo.commits"
        :refs="repo.refs"
        :selected-index="repo.selectedIndex"
        :loading="repo.streaming"
        :can-load-more="repo.canLoadMore"
        :flat="repo.walkFilter !== undefined"
        @select="repo.select"
        @activate="(index) => emit('activate', index)"
        @load-more="repo.loadMore()"
        @row-enter="hover.onRowEnter"
        @row-leave="hover.onRowLeave"
        @menu="openMenu"
        @ref-menu="openRefMenu"
        @copy-hash="(index) => void actions.copyHash(commitAt(index)!)"
      >
        <template #after>
          <div v-if="walkError" class="p-3" data-testid="graph-walk-error">
            <ErrorBanner
              :message="walkError.message"
              :output="walkError.output"
              :action="walkError.action"
              :action-icon="walkError.corrupt ? Terminal : undefined"
              open
              @action="onWalkErrorAction"
            />
          </div>
        </template>
      </CommitRows>
    </template>

    <HoverCard
      v-if="hoverCommit && hover.target.value"
      :commit="hoverCommit"
      :refs="repo.refs"
      :anchor="hover.target.value.rect"
      @enter="hover.onCardEnter"
      @leave="hover.onCardLeave"
      @copy-hash="() => void actions.copyHash(hoverCommit!)"
      @select-parent="selectParent"
      @diff-from="
        () => {
          actions.diffFrom(hoverCommit!);
          hover.hide();
        }
      "
      @compare-with="
        () => {
          actions.compareWith(hoverCommit!);
          hover.hide();
        }
      "
    />
    <BranchContextMenu
      v-if="refMenu"
      :target="refMenu.ref"
      :current="currentName"
      :x="refMenu.x"
      :y="refMenu.y"
      @close="closeRefMenu"
      @checkout="chooseRefAction('checkout')"
      @create-here="chooseRefAction('createHere')"
      @merge="chooseRefAction('merge')"
      @rebase="chooseRefAction('rebase')"
      @compare="chooseRefAction('compare')"
      @rename="chooseRefAction('rename')"
      @set-upstream="chooseRefAction('setUpstream')"
      @push="chooseRefAction('push')"
      @delete="chooseRefAction('delete')"
      @delete-tag="chooseRefAction('deleteTag')"
    />
    <CommitContextMenu
      v-if="menu"
      :x="menu.x"
      :y="menu.y"
      :branch="repo.currentBranch?.name ?? null"
      @close="closeMenu"
      @copy-hash="withMenuCommit(actions.copyHash)"
      @copy-message="withMenuCommit(actions.copyMessage)"
      @diff-from="withMenuCommit(actions.diffFrom)"
      @compare-with="withMenuCommit(actions.compareWith)"
      @range-end="withMenuCommit(actions.rangeEnd)"
      @create-branch="withMenuCommit(actions.createBranch)"
      @tag="withMenuCommit(actions.tag)"
      @cherry-pick="withMenuCommit(actions.cherryPick)"
      @revert="withMenuCommit(actions.revert)"
      @reset="withMenuCommit((commit) => actions.reset(commit, repo.currentBranch?.name ?? null))"
      @open-terminal="() => void actions.openTerminal()"
      @open-editor="() => void actions.openEditor()"
    />
  </section>
</template>
