<script setup lang="ts">
// The open project's tabs under the top bar (`Shell / Tabs / 1440`), while it has more than its
// own: the project's tab, named and drawn after the layout it shows, then one tab per comparison,
// "<A> ↔ <B>". A click, or ← and → on the row, show a tab, the arrows keeping the focus on it;
// a press leaves none there. ⌘W, a comparison's close control and a middle click close it. The row
// scrolls sideways, keeping the tab shown in view.

import {
  FileDiff,
  FilePen,
  GitCompareArrows,
  GitGraph,
  LayoutDashboard,
  LayoutList,
  Settings,
  X,
} from "@lucide/vue";
import { computed, nextTick, ref, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";

import { useSettingsStore, type ProjectLayout } from "@/stores/settings";
import { useTabsStore } from "@/stores/tabs";

const { t } = useI18n();
const settings = useSettingsStore();
const tabs = useTabsStore();

/** The project's tab as the layout it shows: the top bar's icon and its name. */
const LAYOUTS: Record<ProjectLayout, { icon: Component; name: string }> = {
  graph: { icon: GitGraph, name: "tabs.graph" },
  review: { icon: FileDiff, name: "tabs.review" },
  changes: { icon: FilePen, name: "tabs.changes" },
  overview: { icon: LayoutDashboard, name: "tabs.overview" },
  worktrees: { icon: LayoutList, name: "tabs.worktrees" },
  settings: { icon: Settings, name: "tabs.settings" },
};

interface RowTab {
  key: string;
  /** The comparison's id; null for the project's tab, which never closes. */
  id: number | null;
  icon: Component;
  name: string;
}

const row = computed<RowTab[]>(() => {
  const own = LAYOUTS[settings.values.layoutMode];
  return [
    { key: "project", id: null, icon: own.icon, name: t(own.name) },
    ...tabs.comparisons.map((tab) => ({
      key: `comparison-${tab.id}`,
      id: tab.id,
      icon: GitCompareArrows,
      name: t("tabs.comparison", { a: tab.a.label, b: tab.b.label }),
    })),
  ];
});

const list = ref<HTMLElement | null>(null);
const tabAt = (index: number) =>
  list.value?.querySelector<HTMLElement>(`[data-index="${index}"]`) ?? null;

/* The tab shown stays in view, wherever it moved from. */
watch(
  () => [tabs.activeIndex, row.value.length] as const,
  ([index]) => {
    void nextTick(() => tabAt(index)?.scrollIntoView?.({ block: "nearest", inline: "nearest" }));
  },
  { immediate: true },
);

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const count = row.value.length;
  const next = (tabs.activeIndex + (event.key === "ArrowRight" ? 1 : -1) + count) % count;
  tabs.showIndex(next);
  void nextTick(() => tabAt(next)?.focus());
}

/** A press shows the tab without taking the focus; the middle button scrolls nothing. */
function onMousedown(event: MouseEvent): void {
  if (event.button === 0 || event.button === 1) event.preventDefault();
}

function close(tab: RowTab): void {
  if (tab.id !== null) tabs.close(tab.id);
}

function onAuxclick(event: MouseEvent, tab: RowTab): void {
  if (event.button === 1) close(tab);
}
</script>

<template>
  <div
    ref="list"
    role="tablist"
    :aria-label="t('tabs.label')"
    class="tab-row flex h-panel-header shrink-0 items-stretch overflow-x-auto border-b border-line pl-1"
    data-testid="tab-row"
    @keydown="onKeydown"
  >
    <div
      v-for="(tab, index) in row"
      :key="tab.key"
      role="tab"
      class="tab group flex shrink-0 items-center gap-2 border-b-2 px-3 text-md font-medium"
      :class="
        index === tabs.activeIndex
          ? 'border-fg text-fg'
          : 'border-transparent text-fg-secondary hover:text-fg'
      "
      :aria-selected="index === tabs.activeIndex"
      :tabindex="index === tabs.activeIndex ? 0 : -1"
      :data-tooltip="tab.name"
      :data-index="index"
      data-testid="tab"
      @mousedown="onMousedown"
      @click="tabs.showIndex(index)"
      @auxclick="(event: MouseEvent) => onAuxclick(event, tab)"
    >
      <component
        :is="tab.icon"
        :size="16"
        :stroke-width="1.5"
        aria-hidden="true"
        class="shrink-0"
      />
      <span class="truncate" data-testid="tab-name">{{ tab.name }}</span>
      <span
        v-if="tab.id !== null"
        class="tab-close flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-hover"
        :class="index === tabs.activeIndex ? 'text-fg-secondary' : 'text-fg-muted'"
        aria-hidden="true"
        data-testid="tab-close"
        @click.stop="close(tab)"
      >
        <X :size="12" :stroke-width="1.5" />
      </span>
    </div>
  </div>
</template>

<style scoped>
/* The row scrolls sideways without drawing a scrollbar over the tabs. */
.tab-row {
  scrollbar-width: none;
}

/* The frame's 240px: a longer name ends in an ellipsis, the whole name in the tooltip. */
.tab {
  max-width: 240px;
}

/* The close control shows on the tab shown and under the pointer; elsewhere it keeps its room. */
.tab:not([aria-selected="true"]):not(:hover) .tab-close {
  visibility: hidden;
}
</style>
