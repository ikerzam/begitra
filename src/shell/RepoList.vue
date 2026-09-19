<script setup lang="ts">
// The Repos tab: the open repository, or the folder that failed to open, as one
// row that is focusable and navigable like the other lists.

import { CircleAlert, FolderGit2 } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import ListRow from "@/components/ListRow.vue";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import { useRepoStore } from "@/stores/repo";

import { baseName } from "./format";

const { t } = useI18n();
const repo = useRepoStore();
const listbox = ref<HTMLElement | null>(null);

const repoName = computed(() => {
  const state = repo.state;
  if (state.kind === "ready") return baseName(repo.repo?.root ?? "");
  if (state.kind === "opening" || state.kind === "error") return baseName(state.path);
  return "";
});
const rowCount = computed(() => (repo.state.kind === "empty" ? 0 : 1));
const selectedRow = ref(0);

const navigation = useListNavigation({
  count: rowCount,
  selected: selectedRow,
  rowElement: () => listbox.value?.querySelector('[data-index="0"]'),
});

defineExpose({ focus: navigation.focus });
</script>

<template>
  <div
    id="sidebar-repos"
    ref="listbox"
    role="listbox"
    :aria-label="t('sidebar.repos')"
    class="min-h-0 flex-1 overflow-y-auto"
    data-testid="repo-list"
    @keydown="navigation.onKeydown"
  >
    <ListRow
      v-if="repo.state.kind === 'ready' || repo.state.kind === 'opening'"
      data-index="0"
      :name="repoName"
      :icon="FolderGit2"
      :meta="repo.repo?.currentBranch ?? ''"
      selected
    />
    <div
      v-else-if="repo.state.kind === 'error'"
      role="option"
      aria-selected="true"
      tabindex="0"
      data-index="0"
      class="flex h-row-list items-center gap-2 border-l-2 border-accent bg-selected px-3 text-md"
      data-testid="repo-row-error"
    >
      <CircleAlert :size="16" :stroke-width="1.5" aria-hidden="true" class="text-danger" />
      <span class="flex-1 truncate text-fg">{{ repoName }}</span>
      <span class="text-sm text-danger">{{ t("sidebar.notFound") }}</span>
    </div>
    <p v-else class="px-3 py-2 text-md text-fg-secondary">{{ t("sidebar.noRepository") }}</p>
  </div>
</template>
