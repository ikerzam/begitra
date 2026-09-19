<script setup lang="ts">
// The graph area of graph focus: the filter bar and the commit rows, with the loading and
// error states of the shell.

import { Folder, Search } from "@lucide/vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import EmptyState from "@/components/EmptyState.vue";
import ErrorBanner from "@/components/ErrorBanner.vue";
import Input from "@/components/Input.vue";
import Select from "@/components/Select.vue";
import { matchesQuery } from "@/palette/usePalette";
import { errorText } from "@/shell/errorMessage";
import { useRepoStore } from "@/stores/repo";

import CommitRows from "./CommitRows.vue";

const emit = defineEmits<{ activate: [index: number]; removeFromList: [] }>();

const { t } = useI18n();
const repo = useRepoStore();
const search = ref("");
const rows = ref<{ focus(): void } | null>(null);

/** Rows matching the search; indexes map back to the store's commit list. */
const visible = computed(() => {
  const query = search.value.trim();
  const entries = repo.commits.map((commit, index) => ({ commit, index }));
  if (query === "") return entries;
  return entries.filter(({ commit }) =>
    matchesQuery(`${commit.subject} ${commit.author.name}`, query),
  );
});
const visibleCommits = computed(() => visible.value.map((entry) => entry.commit));
const visibleSelected = computed(() =>
  visible.value.findIndex((entry) => entry.index === repo.selectedIndex),
);

function select(position: number): void {
  const entry = visible.value[position];
  if (entry) repo.select(entry.index);
}

function activate(position: number): void {
  const entry = visible.value[position];
  if (entry) emit("activate", entry.index);
}

const errorMessage = computed(() => {
  const state = repo.state;
  if (state.kind !== "error") return "";
  const text = errorText(state.error, state.path);
  return t(text.key, text.params);
});

const walkErrorMessage = computed(() => {
  if (!repo.walkError) return "";
  const text = errorText(repo.walkError);
  return t("graph.historyStopped", { message: t(text.key, text.params) });
});

const disabledOptions = (label: string) => [{ value: "", label }];

defineExpose({ focus: () => rows.value?.focus() });
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col" data-testid="graph-panel">
    <!-- A failed open has no filter bar: the banner takes the whole area. -->
    <div
      v-if="repo.state.kind !== 'error'"
      class="flex h-bar-top shrink-0 items-center gap-2 border-b border-line px-3"
      data-testid="graph-filters"
    >
      <div class="graph-search shrink-0">
        <Input v-model="search" :placeholder="t('graph.searchCommits')" :icon="Search" />
      </div>
      <div class="graph-scope shrink-0">
        <Select :options="disabledOptions(t('graph.allBranches'))" disabled />
      </div>
      <div class="graph-author shrink-0">
        <Select :options="disabledOptions(t('graph.anyone'))" disabled />
      </div>
      <div class="graph-date shrink-0">
        <Select :options="disabledOptions(t('graph.anyDate'))" disabled />
      </div>
      <Button variant="ghost" :icon="Folder" disabled>{{ t("graph.path") }}</Button>
    </div>

    <div v-if="repo.state.kind === 'error'" class="p-5" data-testid="graph-error">
      <ErrorBanner
        :message="errorMessage"
        :output="repo.state.error.detail"
        :action="t('graph.removeFromList')"
        @action="emit('removeFromList')"
      />
    </div>

    <template v-else>
      <CommitRows
        ref="rows"
        :commits="visibleCommits"
        :refs="repo.refs"
        :selected-index="visibleSelected"
        :loading="repo.streaming"
        :can-load-more="repo.canLoadMore"
        @select="select"
        @activate="activate"
        @load-more="repo.loadMore()"
      />
      <div v-if="walkErrorMessage" class="p-3" data-testid="graph-walk-error">
        <ErrorBanner :message="walkErrorMessage" :output="repo.walkError?.detail" open />
      </div>
      <EmptyState
        v-if="!repo.streaming && repo.commits.length === 0 && repo.state.kind === 'ready'"
        :message="t('graph.noCommits')"
      />
      <EmptyState
        v-else-if="!repo.streaming && repo.commits.length > 0 && visible.length === 0"
        :message="t('graph.noMatches')"
      >
        <Button variant="secondary" @click="search = ''">{{ t("graph.clearFilter") }}</Button>
      </EmptyState>
    </template>
  </section>
</template>

<style scoped>
/* Control widths of the filter bar: search 200, then the three selects
   sized to their content (124, 104, 104). None is on the spacing scale. */
.graph-search {
  width: 200px;
}

.graph-scope {
  width: 124px;
}

.graph-author,
.graph-date {
  width: 104px;
}
</style>
