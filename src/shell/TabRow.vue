<script setup lang="ts">
// The row of tabs under the top bar, across the window above the sidebar: in a project its fixed
// tabs (Graph, Review, Changes with its count of changed files, and the Overview while the
// project holds several repositories), at Home Home's, then the tabs opened on demand (each
// comparison, "<A> ↔ <B>" with a commit's short hash in mono, the dashboard and the settings).
// A click, or ← and → on the row, show a tab; while the row holds the focus, the focus follows
// the tab shown, whatever showed it (Ctrl Tab, ⌘1), and a press leaves no focus there. ⌘W, an
// open tab's close control and a middle click close it; a fixed tab and Home's never close. The
// row scrolls sideways, the wheel too, its edges fading while tabs lie past them, and keeps the
// tab shown in view.

import {
  FileDiff,
  FilePen,
  GitCompareArrows,
  GitGraph,
  LayoutGrid,
  LayoutDashboard,
  LayoutList,
  Settings,
  X,
} from "@lucide/vue";
import { computed, nextTick, ref, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";

import { shortcutRegistry } from "@/shortcuts/registry";
import type { CompareEndpoint } from "@/stores/settings";
import { useTabsStore, type TabKey, type TabKind } from "@/stores/tabs";

import { TAB_PANEL_ID, tabElementId } from "./tabIds";
import { useChangedCount } from "./useChangedCount";

/** A tab was pressed, the shown one included: the shell hands the focus to its layout. */
const emit = defineEmits<{ shown: [] }>();

const { t, n } = useI18n();
const tabs = useTabsStore();
const changedCount = useChangedCount();

/** Each view's icon, name and the shortcut that shows it. */
const VIEWS: Record<
  Exclude<TabKind, "compare">,
  { icon: Component; name: string; key?: string }
> = {
  graph: { icon: GitGraph, name: "tabs.graph", key: "graph-focus" },
  review: { icon: FileDiff, name: "tabs.review", key: "review-focus" },
  changes: { icon: FilePen, name: "tabs.changes", key: "changes-focus" },
  overview: { icon: LayoutDashboard, name: "tabs.overview", key: "overview-focus" },
  worktrees: { icon: LayoutList, name: "tabs.worktrees" },
  settings: { icon: Settings, name: "tabs.settings", key: "settings" },
  home: { icon: LayoutGrid, name: "tabs.projects" },
};

/** A commit endpoint: its revision is a full hash, its label the short one. */
const isCommit = (endpoint: CompareEndpoint) =>
  endpoint.kind === "revision" && /^[0-9a-f]{40}$/.test(endpoint.rev);

interface NamePart {
  text: string;
  mono: boolean;
}

interface RowTab {
  key: TabKey;
  /** Whether it closes: a tab opened on demand. */
  closable: boolean;
  icon: Component;
  /** The whole name, for the tooltip and assistive technology. */
  name: string;
  parts: NamePart[];
  /** The changed files after the Changes tab's name; 0 shows none. */
  count: number;
  /** The shortcut that shows it, for its tooltip. */
  keys: string;
}

const row = computed<RowTab[]>(() =>
  tabs.row.map((tab) => {
    if (tab.open?.kind === "compare") {
      const { a, b } = tab.open;
      return {
        key: tab.key,
        closable: true,
        icon: GitCompareArrows,
        name: t("tabs.comparison", { a: a.label, b: b.label }),
        parts: [
          { text: a.label, mono: isCommit(a) },
          { text: " ↔ ", mono: false },
          { text: b.label, mono: isCommit(b) },
        ],
        count: 0,
        keys: "",
      };
    }
    const view = VIEWS[tab.kind === "compare" ? "graph" : tab.kind];
    const name = t(view.name);
    return {
      key: tab.key,
      closable: tab.open !== null,
      icon: view.icon,
      name,
      parts: [{ text: name, mono: false }],
      count: tab.kind === "changes" ? changedCount.value : 0,
      keys: view.key ? shortcutRegistry().hint(view.key) : "",
    };
  }),
);

/** The Changes tab names its count for assistive technology. */
function labelOf(tab: RowTab): string | undefined {
  return tab.count > 0 ? t("tabs.changesCount", { n: n(tab.count) }, tab.count) : undefined;
}

/** What the tooltip adds to a tab's name: the key that shows it and the one that closes it. */
function descriptionOf(tab: RowTab): string | undefined {
  const close = tab.closable ? t("tabs.closeWith", { keys: closeKeys.value }) : "";
  if (tab.keys && close) return t("tabs.keysAndClose", { keys: tab.keys, close });
  return tab.keys || close || undefined;
}

/** The count after the Changes tab's name: "999+" past three digits, as a count button's. */
const countText = (count: number) => (count > 999 ? `${n(999)}+` : n(count));

const closeKeys = computed(() => shortcutRegistry().hint("close-tab"));

const list = ref<HTMLElement | null>(null);
const tabAt = (index: number) =>
  list.value?.querySelector<HTMLElement>(`[data-index="${index}"]`) ?? null;

/* The tab shown stays in view; while the row holds the focus, the focus goes with it. */
watch(
  () => tabs.activeIndex,
  (index) => {
    const held = list.value?.contains(document.activeElement) ?? false;
    void nextTick(() => {
      const tab = tabAt(index);
      tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      if (held) tab?.focus();
    });
  },
);

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  tabs.step(event.key === "ArrowRight" ? 1 : -1);
}

/** A press shows a tab without moving the focus, whichever button; the middle one scrolls not. */
function onMousedown(event: MouseEvent): void {
  event.preventDefault();
}

function show(index: number): void {
  tabs.showIndex(index);
  emit("shown");
}

function close(tab: RowTab): void {
  if (tab.closable && typeof tab.key === "number") tabs.close(tab.key);
}

function onAuxclick(event: MouseEvent, tab: RowTab): void {
  if (event.button === 1) close(tab);
}

/** The wheel scrolls the row sideways while it holds more tabs than it shows. */
function onWheel(event: WheelEvent): void {
  const element = list.value;
  if (!element || element.scrollWidth <= element.clientWidth) return;
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  event.preventDefault();
  element.scrollLeft += event.deltaY;
}
</script>

<template>
  <div class="tab-strip relative flex h-panel-header shrink-0 border-b border-line">
    <div
      ref="list"
      role="tablist"
      :aria-label="t('tabs.label')"
      class="tab-row flex min-w-0 flex-1 items-stretch overflow-x-auto pl-1"
      data-testid="tab-row"
      @keydown="onKeydown"
      @wheel="onWheel"
    >
      <div
        v-for="(tab, index) in row"
        :id="tabElementId(tab.key)"
        :key="tabElementId(tab.key)"
        role="tab"
        class="tab flex shrink-0 cursor-pointer items-center gap-2 border-b-2 px-3 text-md font-medium"
        :class="
          index === tabs.activeIndex
            ? 'border-fg text-fg'
            : 'border-transparent text-fg-secondary hover:text-fg'
        "
        :aria-selected="index === tabs.activeIndex"
        :aria-controls="index === tabs.activeIndex ? TAB_PANEL_ID : undefined"
        :aria-label="labelOf(tab)"
        :aria-description="descriptionOf(tab)"
        :tabindex="index === tabs.activeIndex ? 0 : -1"
        :data-tooltip="tab.name"
        :data-tooltip-keys="tab.keys || undefined"
        :data-index="index"
        data-testid="tab"
        @mousedown="onMousedown"
        @click="show(index)"
        @auxclick="(event: MouseEvent) => onAuxclick(event, tab)"
      >
        <component
          :is="tab.icon"
          :size="16"
          :stroke-width="1.5"
          aria-hidden="true"
          class="shrink-0"
        />
        <span class="truncate" data-testid="tab-name">
          <span
            v-for="(part, at) in tab.parts"
            :key="at"
            :class="{ 'font-mono text-mono-sm': part.mono }"
            >{{ part.text }}</span
          >
        </span>
        <span
          v-if="tab.count > 0"
          class="font-normal text-fg-muted tabular-nums"
          aria-hidden="true"
          data-testid="tab-count"
          >{{ countText(tab.count) }}</span
        >
        <span
          v-if="tab.closable"
          class="tab-close flex size-icon shrink-0 items-center justify-center rounded-sm hover:bg-hover hover:text-fg active:bg-active"
          :class="index === tabs.activeIndex ? 'text-fg-secondary' : 'text-fg-muted'"
          :data-tooltip="t('tabs.close')"
          :data-tooltip-keys="closeKeys || undefined"
          aria-hidden="true"
          data-testid="tab-close"
          @click.stop="close(tab)"
        >
          <X :size="12" :stroke-width="1.5" />
        </span>
      </div>
    </div>
    <span class="tab-fade tab-fade-start" aria-hidden="true" />
    <span class="tab-fade tab-fade-end" aria-hidden="true" />
  </div>
</template>

<style scoped>
/* The row scrolls sideways with no bar, as the graph's filter bar does: 32px has no room for
   one under the tabs. Not `scrollbar-width`, which would override the page's base rules. */
.tab-row::-webkit-scrollbar {
  height: 0;
}

/* 240px at most, off the spacing scale: a longer name ends in an ellipsis, the whole name in
   the tooltip. */
.tab {
  max-width: 240px;
}

/* The row clips its tabs' outer edges, so the ring goes inside, over the underline. */
.tab:focus-visible {
  outline-offset: -2px;
}

/* The close control shows on the tab shown and under the pointer; elsewhere it keeps its room. */
.tab:not([aria-selected="true"]):not(:hover) .tab-close {
  visibility: hidden;
}

/* The edge with tabs past it fades over 24px, as the filter bar's does: two strips that follow
   the row's scroll through a named scroll timeline; a row that fits keeps them at 0. */
.tab-fade {
  position: absolute;
  top: 0;
  bottom: 0;
  width: var(--space-5);
  pointer-events: none;
  opacity: 0;
}

.tab-fade-start {
  left: 0;
  background: linear-gradient(to left, transparent, var(--bg-app));
}

.tab-fade-end {
  right: 0;
  background: linear-gradient(to right, transparent, var(--bg-app));
}

@supports (animation-timeline: scroll()) {
  .tab-strip {
    timeline-scope: --tab-row;
  }

  .tab-row {
    scroll-timeline: --tab-row inline;
  }

  .tab-fade {
    animation-duration: 1ms;
    animation-timing-function: linear;
    animation-fill-mode: both;
    animation-timeline: --tab-row;
  }

  .tab-fade-start {
    animation-name: tab-fade-start;
  }

  .tab-fade-end {
    animation-name: tab-fade-end;
  }
}

@keyframes tab-fade-start {
  0% {
    opacity: 0;
  }
  8%,
  100% {
    opacity: 1;
  }
}

@keyframes tab-fade-end {
  0%,
  92% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
</style>
