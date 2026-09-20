<script setup lang="ts">
// The filter bar of the graph: search, scope, author,
// date range and path, each filled when active; the pinned-commit chips; the count line and
// "Clear" once something narrows the history.

import { Folder, Search, X } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Input from "@/components/Input.vue";
import Select from "@/components/Select.vue";
import type { SelectOption } from "@/components/types";
import { formatCount, shortHash } from "@/shell/format";
import { DATE_RANGES, useGraphStore, type DateRange, type GraphScope } from "@/stores/graph";

import PathPopover from "./PathPopover.vue";

/** Delay between the last keystroke and the walk restart. */
const SEARCH_DEBOUNCE_MS = 200;

const { t, locale } = useI18n();
const graph = useGraphStore();

const text = ref(graph.filters.text);
let debounce: ReturnType<typeof setTimeout> | undefined;

watch(text, (value) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => graph.setText(value), SEARCH_DEBOUNCE_MS);
});

// A clear (or another repository) resets the field without a restart of its own.
watch(
  () => graph.filters.text,
  (value) => {
    if (value !== text.value) {
      clearTimeout(debounce);
      text.value = value;
    }
  },
);

onBeforeUnmount(() => clearTimeout(debounce));

const REF_SCOPE = "ref:";

const scopeOptions = computed<SelectOption[]>(() => {
  const options: SelectOption[] = [
    { value: "all", label: t("graph.allBranches") },
    { value: "current", label: t("graph.currentBranch") },
  ];
  const scope = graph.filters.scope;
  if (scope.kind === "ref") options.push({ value: REF_SCOPE + scope.fullName, label: scope.name });
  return options;
});

const scopeValue = computed({
  get: () => {
    const scope = graph.filters.scope;
    return scope.kind === "ref" ? REF_SCOPE + scope.fullName : scope.kind;
  },
  set: (value: string) => {
    let scope: GraphScope = { kind: "all" };
    if (value === "current") scope = { kind: "current" };
    else if (value.startsWith(REF_SCOPE)) {
      const current = graph.filters.scope;
      if (current.kind === "ref") scope = current;
    }
    graph.setScope(scope);
  },
});

const authorOptions = computed<SelectOption[]>(() => {
  const options: SelectOption[] = [{ value: "", label: t("graph.anyone") }];
  const names = graph.authorList.map((author) => author.name);
  const chosen = graph.filters.author;
  if (chosen !== "" && !names.includes(chosen)) names.unshift(chosen);
  for (const name of names) options.push({ value: name, label: name });
  return options;
});

const authorValue = computed({
  get: () => graph.filters.author,
  set: (value: string) => graph.setAuthor(value),
});

const dateOptions = computed<SelectOption[]>(() =>
  DATE_RANGES.map((range) => ({ value: range, label: t(`graph.dateRange.${range}`) })),
);

const dateValue = computed({
  get: () => graph.filters.dateRange,
  set: (value: string) => graph.setDateRange(value as DateRange),
});

const pathOpen = ref(false);
const pathButton = ref<{ $el: HTMLElement } | null>(null);

/** Closing the popover unmounts its focused input: the focus returns to the button. */
function closePath(): void {
  pathOpen.value = false;
  pathButton.value?.$el.focus();
}

const countLine = computed(() => {
  if (!graph.isFiltered) return "";
  const matches = formatCount(graph.matches, locale.value);
  const total = graph.total;
  if (!total) return t("graph.countMatches", { n: matches }, graph.matches);
  const known = formatCount(total.count, locale.value) + (total.capped ? "+" : "");
  return t("graph.countOf", { n: matches, m: known }, graph.matches);
});
</script>

<template>
  <div
    class="flex h-bar-top shrink-0 items-center gap-2 border-b border-line px-3"
    data-testid="graph-filters"
  >
    <div class="graph-search shrink-0">
      <Input v-model="text" :placeholder="t('graph.searchCommits')" :icon="Search" />
    </div>
    <div class="graph-scope shrink-0">
      <Select
        v-model="scopeValue"
        :options="scopeOptions"
        :label="t('graph.scope')"
        :active="graph.filters.scope.kind !== 'all'"
        data-testid="filter-scope"
      />
    </div>
    <div class="graph-author shrink-0">
      <Select
        v-model="authorValue"
        :options="authorOptions"
        :label="t('graph.author')"
        :active="graph.filters.author !== ''"
        data-testid="filter-author"
      />
    </div>
    <div class="graph-date shrink-0">
      <Select
        v-model="dateValue"
        :options="dateOptions"
        :label="t('graph.date')"
        :active="graph.filters.dateRange !== 'any'"
        data-testid="filter-date"
      />
    </div>
    <div class="relative shrink-0">
      <Button
        ref="pathButton"
        variant="ghost"
        :icon="Folder"
        :class="{ 'bg-selected text-fg': graph.filters.path !== '' }"
        :aria-expanded="pathOpen"
        data-testid="filter-path"
        @click="pathOpen = !pathOpen"
      >
        {{ graph.filters.path || t("graph.path") }}
      </Button>
      <PathPopover
        v-if="pathOpen"
        :path="graph.filters.path"
        :anchor="pathButton?.$el"
        @apply="graph.setPath"
        @close="closePath"
      />
    </div>
    <span
      v-if="graph.diffBase"
      class="flex h-control shrink-0 items-center gap-1 rounded-md bg-selected pl-3 text-md text-fg"
      data-testid="chip-diff-base"
    >
      {{ t("graph.diffFromChip", { hash: shortHash(graph.diffBase) }) }}
      <button
        type="button"
        class="flex h-control w-control items-center justify-center rounded-md text-fg-secondary hover:text-fg"
        :aria-label="t('graph.clearDiffBase')"
        @click="graph.setDiffBase(null)"
      >
        <X :size="16" :stroke-width="1.5" aria-hidden="true" />
      </button>
    </span>
    <span
      v-if="graph.rangeEnd"
      class="flex h-control shrink-0 items-center gap-1 rounded-md bg-selected pl-3 text-md text-fg"
      data-testid="chip-range-end"
    >
      {{ t("graph.rangeEndChip", { hash: shortHash(graph.rangeEnd) }) }}
      <button
        type="button"
        class="flex h-control w-control items-center justify-center rounded-md text-fg-secondary hover:text-fg"
        :aria-label="t('graph.clearRangeEnd')"
        @click="graph.setRangeEnd(null)"
      >
        <X :size="16" :stroke-width="1.5" aria-hidden="true" />
      </button>
    </span>
    <span
      v-if="countLine"
      class="ml-auto truncate text-sm text-fg-muted"
      data-testid="filter-count"
      aria-live="polite"
    >
      {{ countLine }}
    </span>
    <Button
      v-if="graph.isActive"
      variant="ghost"
      :class="{ 'ml-auto': !countLine }"
      data-testid="filter-clear"
      @click="graph.clear()"
    >
      {{ t("graph.clear") }}
    </Button>
  </div>
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
