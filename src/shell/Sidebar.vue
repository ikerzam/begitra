<script setup lang="ts">
// The 240px sidebar: the three tabs, one filter input and the list of the active tab. The
// branch rows' actions run here: checkout, the dialogs of the branches store, a
// merge or rebase, the comparison, a push.

import { Search } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import Input from "@/components/Input.vue";
import type { Ref as GitRef } from "@/ipc/schemas";
import { useBranchesStore } from "@/stores/branches";
import { useCompareStore } from "@/stores/compare";
import { useRemotesStore } from "@/stores/remotes";
import { useRepoStore } from "@/stores/repo";
import { useShellStore } from "@/stores/shell";

import BranchList, { type BranchAction } from "./BranchList.vue";
import RepoList from "./RepoList.vue";
import SidebarTabs from "./SidebarTabs.vue";
import WorktreeList from "./WorktreeList.vue";

const { t } = useI18n();
const shell = useShellStore();
const repo = useRepoStore();

const filter = ref("");

const filterPlaceholder = computed(() => {
  switch (shell.sidebarTab) {
    case "repos":
      return t("sidebar.filterRepos");
    case "worktrees":
      return t("sidebar.filterWorktrees");
    default:
      return t("sidebar.filterBranches");
  }
});

/** A local branch is checked out by name, a remote branch or a tag detached at its commit. */
function checkout(ref: GitRef): void {
  if (ref.isCurrent) return;
  void useBranchesStore().checkout(
    ref.kind === "local-branch"
      ? { kind: "branch", name: ref.name }
      : { kind: "detached", rev: ref.name },
  );
}

function compareWith(ref: GitRef): void {
  const branch = repo.currentBranch;
  void useCompareStore().open(
    branch
      ? { kind: "revision", rev: branch.fullName, label: branch.name }
      : { kind: "revision", rev: "HEAD", label: "HEAD" },
    { kind: "revision", rev: ref.fullName, label: ref.name },
  );
}

function onBranchAction(kind: BranchAction, ref: GitRef): void {
  const branches = useBranchesStore();
  switch (kind) {
    case "checkout":
      checkout(ref);
      break;
    case "createHere":
      branches.ask({ kind: "create", start: ref.name, startLabel: ref.name });
      break;
    case "merge":
      void branches.merge(ref.name, "default");
      break;
    case "rebase":
      void branches.rebase(ref.name);
      break;
    case "compare":
      compareWith(ref);
      break;
    case "rename":
      branches.ask({ kind: "rename", name: ref.name });
      break;
    case "setUpstream":
      branches.ask({ kind: "upstream", branch: ref.name, current: ref.upstream ?? null });
      break;
    case "push":
      useRemotesStore().ask({ kind: "push", branch: ref.name });
      break;
    case "delete":
      branches.ask({ kind: "delete", name: ref.name, force: false, output: "" });
      break;
    case "deleteTag":
      void branches.deleteTag(ref.name);
      break;
  }
}
</script>

<template>
  <aside class="flex w-sidebar shrink-0 flex-col border-r border-line" data-testid="sidebar">
    <SidebarTabs :active="shell.sidebarTab" @select="shell.setSidebarTab" />
    <div class="px-2 py-2">
      <Input v-model="filter" :placeholder="filterPlaceholder" :icon="Search" />
    </div>
    <BranchList v-if="shell.sidebarTab === 'branches'" :filter="filter" @action="onBranchAction" />
    <RepoList v-else-if="shell.sidebarTab === 'repos'" :filter="filter" />
    <WorktreeList v-else :filter="filter" />
  </aside>
</template>
