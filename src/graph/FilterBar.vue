<script setup lang="ts">
// The filter bar of the graph: the repository selector
// while the open project holds more than one repository, then search, scope, author, date range
// and path, each filled when active; the pinned-commit chips; the count line and "Clear" once
// something narrows the history, at the end of the bar outside the controls' row, so a narrow
// panel scrolls the controls and never "Clear".

import { Folder, Search, X } from "@lucide/vue";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import Button from "@/components/Button.vue";
import Input from "@/components/Input.vue";
import Select from "@/components/Select.vue";
import type { SelectOption } from "@/components/types";
import { formatCount, shortHash } from "@/shell/format";
import { DATE_RANGES, useGraphStore, type DateRange, type GraphScope } from "@/stores/graph";
import { useProjectsStore } from "@/stores/projects";

import PathPopover from "./PathPopover.vue";
import RepoSelect from "./RepoSelect.vue";

/** Delay between the last keystroke and the walk restart. */
const SEARCH_DEBOUNCE_MS = 200;

const { t, locale } = useI18n();
const graph = useGraphStore();
const projects = useProjectsStore();

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
    class="flex h-bar-top shrink-0 items-center gap-2 border-b border-line"
    data-testid="graph-filters"
  >
    <div class="filter-row relative flex h-full min-w-0 flex-auto">
      <div
        class="filter-controls flex h-full w-full items-center gap-2 overflow-x-auto px-3"
        data-testid="filter-controls"
      >
        <RepoSelect v-if="projects.multi" />
        <div class="graph-search">
          <Input v-model="text" :placeholder="t('graph.searchCommits')" :icon="Search" />
        </div>
        <div class="graph-scope">
          <Select
            v-model="scopeValue"
            :options="scopeOptions"
            :label="t('graph.scope')"
            :active="graph.filters.scope.kind !== 'all'"
            data-testid="filter-scope"
          />
        </div>
        <div class="graph-author">
          <Select
            v-model="authorValue"
            :options="authorOptions"
            :label="t('graph.author')"
            :active="graph.filters.author !== ''"
            data-testid="filter-author"
          />
        </div>
        <div class="graph-date">
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
      </div>
      <span class="filter-fade filter-fade-start" aria-hidden="true" />
      <span class="filter-fade filter-fade-end" aria-hidden="true" />
    </div>
    <span
      v-if="countLine"
      class="filter-count truncate text-sm text-fg-muted"
      :class="{ 'mr-3': !graph.isActive }"
      data-testid="filter-count"
      aria-live="polite"
    >
      {{ countLine }}
    </span>
    <Button
      v-if="graph.isActive"
      variant="ghost"
      class="mr-3 shrink-0"
      data-testid="filter-clear"
      @click="graph.clear()"
    >
      {{ t("graph.clear") }}
    </Button>
  </div>
</template>

<style scoped>
/* Control widths of the filter bar: search 200, then the three selects
   sized to their content (124, 104, 104). None is on the spacing scale. A panel
   narrower than the bar (the repository selector in front, a narrow window, a high zoom) takes
   its room, in this order, from the count line, down to nothing; from the search and the
   repository selector, down to 112 and 96; and from the selects, down to 88, where a label is
   cut with an ellipsis (the open list shows it whole). Past those widths the controls scroll
   sideways, "Clear" staying at the end: the weights below set the order, since a flex item
   gives up room in proportion to its weight times its width. */
.filter-count {
  flex-shrink: 100;
}

.graph-search {
  flex-shrink: 20;
  width: 200px;
  min-width: 112px;
}

.graph-scope,
.graph-author,
.graph-date {
  min-width: 88px;
}

.graph-scope {
  width: 124px;
}

.graph-author,
.graph-date {
  width: 104px;
}

/* The row's sideways scroll shows no bar: the 40px bar has no room for one under its controls.
   Not `scrollbar-width`, which would override every scrollbar rule of the page's base layer. */
.filter-controls::-webkit-scrollbar {
  height: 0;
}

/* Instead, the edge with controls past it fades over 24px: two strips over the row's edges,
   from transparent to the bar's background, that pass the pointer through. Not a mask on the
   row, which would clip what the row paints outside its box, the select lists and the path
   popover included. The strips follow the row's scroll through a named scroll timeline; a row
   that fits has no timeline, so they keep their resting opacity of 0. */
.filter-fade {
  position: absolute;
  top: 0;
  bottom: 0;
  width: var(--space-5);
  pointer-events: none;
  opacity: 0;
}

.filter-fade-start {
  left: 0;
  background: linear-gradient(to left, transparent, var(--bg-app));
}

.filter-fade-end {
  right: 0;
  background: linear-gradient(to right, transparent, var(--bg-app));
}

@supports (animation-timeline: scroll()) {
  .filter-row {
    timeline-scope: --filter-row;
  }

  .filter-controls {
    scroll-timeline: --filter-row inline;
  }

  .filter-fade {
    animation-duration: 1ms;
    animation-timing-function: linear;
    animation-fill-mode: both;
    animation-timeline: --filter-row;
  }

  .filter-fade-start {
    animation-name: filter-fade-start;
  }

  .filter-fade-end {
    animation-name: filter-fade-end;
  }
}

@keyframes filter-fade-start {
  0% {
    opacity: 0;
  }
  8%,
  100% {
    opacity: 1;
  }
}

@keyframes filter-fade-end {
  0%,
  92% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
</style>
