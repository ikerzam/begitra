<script setup lang="ts">
// The commit list of the graph: virtualised rows over a spacer, the lane canvas at the top of
// the viewport, j/k navigation with the selected row always rendered (so focus never falls
// off), prefetch of the next pages, and the pointer and keyboard entry points of the hover
// card and the context menu (owned by the panel).

import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import GraphRow from "@/components/GraphRow.vue";
import RefBadge from "@/components/RefBadge.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import type { CommitNode, Ref as GitRef } from "@/ipc/schemas";
import { relativeDate, shortHash } from "@/shell/format";
import { useNow } from "@/shell/useNow";
import { useListNavigation } from "@/shortcuts/useListNavigation";

import { shortcutRegistry } from "@/shortcuts/registry";

import { commitBadges, refsByName, upstreamNames, type Badge } from "./badges";
import GraphCanvas from "./GraphCanvas.vue";
import { ROW_HEIGHT } from "./useGraphGeometry";
import { useVirtualRows } from "./useVirtualRows";

const props = withDefaults(
  defineProps<{
    commits: CommitNode[];
    refs: GitRef[];
    selectedIndex: number;
    /** Rows are still arriving; skeleton rows show below the ones received. */
    loading?: boolean;
    /** More pages can be requested. */
    canLoadMore?: boolean;
    skeletonRows?: number;
    /** A filtered walk: rows in one lane joined by a straight line. */
    flat?: boolean;
    /**
     * The remote branches are hidden: a remote branch draws only as an upstream or as one of
     * `scopeRemotes`.
     */
    hideRemotes?: boolean;
    /** The remote branches the scope names (short names), which draw while hidden. */
    scopeRemotes?: readonly string[];
  }>(),
  {
    loading: false,
    canLoadMore: false,
    skeletonRows: 8,
    flat: false,
    hideRemotes: false,
    scopeRemotes: () => [],
  },
);

const emit = defineEmits<{
  select: [index: number];
  activate: [index: number];
  loadMore: [];
  /** The pointer rested on a row, or left it. */
  rowEnter: [index: number, rect: DOMRect];
  rowLeave: [];
  /** A context menu for a row, at viewport coordinates. */
  menu: [index: number, x: number, y: number];
  /** A context menu for a ref badge of a row, at viewport coordinates. */
  refMenu: [index: number, ref: GitRef, x: number, y: number];
  copyHash: [index: number];
  /** Ctrl-click (⌘ on macOS) on a row: compare the selected commit with this one. */
  compare: [index: number];
  /** A double click on a branch's badge: check the branch out. */
  refActivate: [ref: GitRef];
}>();

/** Rows left before the loaded end when the next pages are requested. */
const PREFETCH_ROWS = 200;

const { t } = useI18n();
const container = ref<HTMLElement | null>(null);
const now = useNow();

const commitCount = computed(() => props.commits.length);
const rowCount = computed(() => commitCount.value + (props.loading ? props.skeletonRows : 0));
const virtual = useVirtualRows(container, { rowHeight: ROW_HEIGHT, count: rowCount });

/** Rows to render: the range, plus the selected row so its focus survives a scroll away. */
const rendered = computed(() => {
  const { start, end } = virtual.range.value;
  const indexes: number[] = [];
  const selected = props.selectedIndex;
  if (selected >= 0 && selected < start && selected < commitCount.value) indexes.push(selected);
  for (let i = start; i < end; i += 1) indexes.push(i);
  if (selected >= end && selected < commitCount.value) indexes.push(selected);
  return indexes;
});

/** The row the keyboard asked for, before the parent confirms it through the prop. */
let requested = -1;
const selected = computed({
  get: () => props.selectedIndex,
  set: (index: number) => {
    requested = index;
    emit("select", index);
  },
});

const navigation = useListNavigation({
  count: commitCount,
  selected,
  onActivate: (index) => emit("activate", index),
  rowElement: (index) => container.value?.querySelector(`[data-index="${index}"]`),
});

const badgesByName = computed(() => refsByName(props.refs));
const badgeOptions = computed(() => ({
  join: true,
  hideRemotes: props.hideRemotes,
  shown: new Set([...upstreamNames(props.refs), ...props.scopeRemotes]),
}));

function badges(commit: CommitNode): Badge[] {
  return commitBadges(commit.refs, badgesByName.value, commit.hash, badgeOptions.value);
}

/**
 * A click selects the row; with Ctrl (⌘ on macOS) and another commit selected, it compares the
 * selected commit with the row's instead, the selection staying.
 */
function onRowSelect(index: number, event?: MouseEvent): void {
  const compareKey =
    event && (shortcutRegistry().platform === "macos" ? event.metaKey : event.ctrlKey);
  if (compareKey && props.selectedIndex >= 0 && props.selectedIndex !== index) {
    emit("compare", index);
    return;
  }
  emit("select", index);
}

/** A double click on a branch's badge checks the branch out; the row's review stays shut. */
function onBadgeActivate(badge: Badge, event: MouseEvent): void {
  event.stopPropagation();
  const ref = badge.ref;
  if (ref && (ref.kind === "local-branch" || ref.kind === "remote-branch")) {
    emit("refActivate", ref);
  }
}

function date(commit: CommitNode): string {
  const rel = relativeDate(commit.author.time, now.value);
  return rel.unit === "now" ? t("date.now") : t(`date.${rel.unit}`, { n: rel.n });
}

/** Scrolls a row (the selected one by default) into the viewport and focuses it once rendered. */
async function revealSelected(
  focus: boolean,
  index = props.selectedIndex,
  align: "nearest" | "center" = "nearest",
): Promise<void> {
  if (index < 0) return;
  virtual.scrollToIndex(index, align);
  await nextTick();
  const element = container.value?.querySelector<HTMLElement>(`[data-index="${index}"]`);
  if (focus) element?.focus({ preventScroll: true });
}

function selectedRect(): DOMRect | undefined {
  return container.value
    ?.querySelector(`[data-index="${props.selectedIndex}"]`)
    ?.getBoundingClientRect();
}

function onKeydown(event: KeyboardEvent): void {
  const index = props.selectedIndex;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && index >= 0) {
    event.preventDefault();
    emit("copyHash", index);
    return;
  }
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    if (index < 0) return;
    event.preventDefault();
    const rect = selectedRect();
    emit("menu", index, rect ? rect.left + 116 : 0, rect ? rect.bottom : 0);
    return;
  }
  if (navigation.onKeydown(event)) void revealSelected(true, requested);
}

function onScroll(): void {
  virtual.onScroll();
  emit("rowLeave");
}

/** A badge with a ref behind it opens the ref's menu instead of the commit's. */
function onBadgeMenu(index: number, badge: Badge, event: MouseEvent): void {
  if (!badge.ref) return;
  event.preventDefault();
  event.stopPropagation();
  emit("select", index);
  emit("refMenu", index, badge.ref, event.clientX, event.clientY);
}

function onContextMenu(index: number, event: MouseEvent): void {
  event.preventDefault();
  emit("select", index);
  emit("menu", index, event.clientX, event.clientY);
}

function onRowEnter(index: number, event: PointerEvent): void {
  if (!(event.currentTarget instanceof HTMLElement)) return;
  emit("rowEnter", index, event.currentTarget.getBoundingClientRect());
}

// The next pages are requested before the rendered rows reach the loaded end.
watch(
  () => [virtual.range.value.end, commitCount.value, props.canLoadMore] as const,
  ([end, count, canLoadMore]) => {
    if (canLoadMore && end >= count - PREFETCH_ROWS) emit("loadMore");
  },
  { immediate: true },
);

// A selection made elsewhere (the detail's parent link, a restarted walk) is scrolled into
// view without taking the focus.
watch(
  () => props.selectedIndex,
  (index) => {
    if (index >= 0 && !virtual.isVisible(index)) void revealSelected(false);
  },
);

/* The selected row is the tab stop; before a selection exists, the first row is. */
const tabStop = computed(() => (props.selectedIndex >= 0 ? props.selectedIndex : 0));

defineExpose({ focus: navigation.focus, revealSelected });
</script>

<template>
  <div
    ref="container"
    role="listbox"
    :aria-label="t('graph.commits')"
    :aria-busy="props.loading"
    class="commit-rows relative min-h-0 flex-1 overflow-y-auto"
    data-testid="commit-rows"
    @keydown="onKeydown"
    @scroll.passive="onScroll"
  >
    <div class="relative" :style="{ height: `${virtual.totalHeight.value}px` }">
      <GraphCanvas
        :commits="props.commits"
        :start="virtual.range.value.start"
        :end="virtual.range.value.end"
        :scroll-top="virtual.scrollTop.value"
        :height="virtual.viewportHeight.value"
        :flat="props.flat"
      />
      <template v-for="index in rendered" :key="props.commits[index]?.hash ?? `skeleton-${index}`">
        <GraphRow
          v-if="props.commits[index]"
          :data-index="index"
          class="absolute right-0 left-0"
          :style="{ top: `${virtual.rowTop(index)}px` }"
          :message="props.commits[index].subject"
          :author="props.commits[index].author.name"
          :date="date(props.commits[index])"
          :hash="shortHash(props.commits[index].hash)"
          :selected="index === props.selectedIndex"
          :tab-stop="index === tabStop"
          @select="(event?: MouseEvent) => onRowSelect(index, event)"
          @activate="emit('activate', index)"
          @contextmenu="(event: MouseEvent) => onContextMenu(index, event)"
          @pointerenter="(event: PointerEvent) => onRowEnter(index, event)"
          @pointerleave="emit('rowLeave')"
        >
          <template #lanes>
            <span class="graph-lane-area block shrink-0" aria-hidden="true" />
          </template>
          <template v-if="badges(props.commits[index]).length > 0" #refs>
            <RefBadge
              v-for="badge in badges(props.commits[index])"
              :key="badge.key"
              :kind="badge.kind"
              :label="badge.label"
              :remote="badge.upstream?.remote"
              :data-ref="badge.ref?.fullName"
              @contextmenu="(event: MouseEvent) => onBadgeMenu(index, badge, event)"
              @dblclick="(event: MouseEvent) => onBadgeActivate(badge, event)"
            />
          </template>
        </GraphRow>
        <SkeletonRow
          v-else
          :index="index"
          height="graph"
          class="absolute right-0 left-0"
          :style="{ top: `${virtual.rowTop(index)}px` }"
        />
      </template>
    </div>
    <slot name="after" />
  </div>
</template>

<style scoped>
/* The rows' width decides which metadata columns fit (GraphRow's container query). */
.commit-rows {
  container-type: inline-size;
}

/* The 108px lane area plus the 8px gap to the first badge or the subject, which starts at
   x = 116; the row's 2px accent border makes up the rest. Not on the spacing scale. */
.graph-lane-area {
  width: 114px;
}
</style>
