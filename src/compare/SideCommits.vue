<script setup lang="ts">
// One side of the comparison ("Only in <name>"): the count from `compare`, then the commits
// of the range walk as virtualised rows with the side's lane dot, skeleton rows until the
// first page, "Nothing only in <name>" for an empty side, the walk's error otherwise; j/k and
// the arrows move, Home/End jump, ↵ opens the commit, and the next page is asked for before
// the rendered rows reach the loaded end.

import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import ErrorBanner from "@/components/ErrorBanner.vue";
import GraphRow from "@/components/GraphRow.vue";
import { laneBgClass } from "@/components/lanes";
import SkeletonRow from "@/components/SkeletonRow.vue";
import { ROW_HEIGHT } from "@/graph/useGraphGeometry";
import { useVirtualRows } from "@/graph/useVirtualRows";
import { errorText } from "@/shell/errorMessage";
import { relativeDate, shortHash } from "@/shell/format";
import { useNow } from "@/shell/useNow";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import type { SideList } from "@/stores/compare";

const props = withDefaults(
  defineProps<{
    name: string;
    /** The count from `compare`; null until it arrives. */
    count: number | null;
    list: SideList;
    lane: number;
    /** The comparison is still counting: skeleton rows until the walk can start. */
    pending?: boolean;
    skeletonRows?: number;
  }>(),
  { pending: false, skeletonRows: 4 },
);
const emit = defineEmits<{ activate: [hash: string]; loadMore: [] }>();

/** Rows left before the loaded end when the next page is requested. */
const PREFETCH_ROWS = 100;

const { t, n } = useI18n();
const container = ref<HTMLElement | null>(null);
const now = useNow();
const selectedIndex = ref(-1);

const commits = computed(() => props.list.commits);
const commitCount = computed(() => commits.value.length);
const showSkeleton = computed(
  () => (props.list.loading || props.pending) && commitCount.value === 0,
);
const rowCount = computed(() => commitCount.value + (showSkeleton.value ? props.skeletonRows : 0));
const virtual = useVirtualRows(container, { rowHeight: ROW_HEIGHT, count: rowCount });
const empty = computed(
  () => !props.list.loading && !props.list.error && props.list.done && commitCount.value === 0,
);
const errorMessage = computed(() => {
  if (!props.list.error) return "";
  const text = errorText(props.list.error);
  return t(text.key, text.params);
});

const rendered = computed(() => {
  const { start, end } = virtual.range.value;
  const indexes: number[] = [];
  const selected = selectedIndex.value;
  if (selected >= 0 && selected < start && selected < commitCount.value) indexes.push(selected);
  for (let i = start; i < end; i += 1) indexes.push(i);
  if (selected >= end && selected < commitCount.value) indexes.push(selected);
  return indexes;
});

const navigation = useListNavigation({
  count: commitCount,
  selected: selectedIndex,
  onActivate: (index) => {
    const commit = commits.value[index];
    if (commit) emit("activate", commit.hash);
  },
  rowElement: (index) => container.value?.querySelector(`[data-index="${index}"]`),
});

function date(time: number): string {
  const rel = relativeDate(time, now.value);
  return rel.unit === "now" ? t("date.now") : t(`date.${rel.unit}`, { n: rel.n });
}

async function onKeydown(event: KeyboardEvent): Promise<void> {
  if (!navigation.onKeydown(event)) return;
  const index = selectedIndex.value;
  if (index < 0) return;
  virtual.scrollToIndex(index);
  await nextTick();
  container.value?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus({
    preventScroll: true,
  });
}

watch(
  () => [virtual.range.value.end, commitCount.value, props.list.done, props.list.loading] as const,
  ([end, count, done, loading]) => {
    if (!done && !loading && count > 0 && end >= count - PREFETCH_ROWS) emit("loadMore");
  },
  { immediate: true },
);

// A new comparison starts the list over.
watch(commits, (list, previous) => {
  if (list.length === 0 || list[0]?.hash !== previous?.[0]?.hash) selectedIndex.value = -1;
});

// One row is always the tab stop: the selected one, else the first rendered one.
const tabStop = computed(() =>
  selectedIndex.value >= 0 ? selectedIndex.value : virtual.range.value.start,
);

defineExpose({ focus: navigation.focus });
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col" :data-testid="`side-${props.name}`">
    <h3
      class="flex h-panel-header shrink-0 items-center gap-2 border-b border-line px-3 text-md font-medium text-fg"
    >
      <span class="truncate">{{ t("compare.onlyIn", { name: props.name }) }}</span>
      <span v-if="props.count !== null" class="text-sm text-fg-muted" data-testid="side-count">
        {{ n(props.count) }}
      </span>
    </h3>
    <div v-if="props.list.error" class="px-3 pb-3">
      <ErrorBanner :message="errorMessage" :output="props.list.error.detail" />
    </div>
    <p v-else-if="empty" class="px-3 py-2 text-md text-fg-muted" data-testid="side-empty">
      {{ t("compare.nothingOnlyIn", { name: props.name }) }}
    </p>
    <div
      v-else
      ref="container"
      role="listbox"
      :aria-label="t('compare.onlyIn', { name: props.name })"
      class="relative min-h-0 flex-1 overflow-y-auto"
      data-testid="side-rows"
      @keydown="(event) => void onKeydown(event)"
      @scroll.passive="virtual.onScroll"
    >
      <div class="relative" :style="{ height: `${virtual.totalHeight.value}px` }">
        <template v-for="index in rendered" :key="commits[index]?.hash ?? `skeleton-${index}`">
          <GraphRow
            v-if="commits[index]"
            :data-index="index"
            class="absolute right-0 left-0"
            :style="{ top: `${virtual.rowTop(index)}px` }"
            :message="commits[index].subject"
            :author="commits[index].author.name"
            :date="date(commits[index].author.time)"
            :hash="shortHash(commits[index].hash)"
            :selected="index === selectedIndex"
            :tab-stop="index === tabStop"
            @select="selectedIndex = index"
            @activate="emit('activate', commits[index].hash)"
          >
            <template #lanes>
              <span class="flex w-6 shrink-0 items-center justify-center" aria-hidden="true">
                <span
                  class="h-2 w-2 rounded-full"
                  :class="props.lane > 0 ? laneBgClass(props.lane) : 'bg-fg-muted'"
                />
              </span>
            </template>
          </GraphRow>
          <SkeletonRow
            v-else
            class="absolute right-0 left-0"
            :style="{ top: `${virtual.rowTop(index)}px` }"
            :index="index"
            height="graph"
          />
        </template>
      </div>
    </div>
  </section>
</template>
