<script setup lang="ts">
// The commit list: text rows without lanes, j/k navigation, more pages on demand.

import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import GraphRow from "@/components/GraphRow.vue";
import RefBadge from "@/components/RefBadge.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import type { RefKind as BadgeKind } from "@/components/types";
import type { CommitNode, Ref as GitRef } from "@/ipc/schemas";
import { relativeDate, shortHash } from "@/shell/format";
import { useListNavigation } from "@/shortcuts/useListNavigation";

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
  }>(),
  { loading: false, canLoadMore: false, skeletonRows: 8 },
);
const emit = defineEmits<{ select: [index: number]; activate: [index: number]; loadMore: [] }>();

const { t } = useI18n();
const container = ref<HTMLElement | null>(null);
const now = ref(Date.now());

const count = computed(() => props.commits.length);
const selected = computed({
  get: () => props.selectedIndex,
  set: (index: number) => emit("select", index),
});

const navigation = useListNavigation({
  count,
  selected,
  onActivate: (index) => emit("activate", index),
  rowElement: (index) => container.value?.querySelector(`[data-index="${index}"]`),
});

/** Badge kind and label of a decoration name, using the ref list for the exact kind. */
const badgeByName = computed(() => {
  const map = new Map<string, { kind: BadgeKind; label: string }>();
  for (const ref of props.refs) {
    const kind: BadgeKind =
      ref.kind === "local-branch"
        ? ref.isCurrent
          ? "current"
          : "local"
        : ref.kind === "remote-branch"
          ? "remote"
          : ref.kind === "tag"
            ? "tag"
            : ref.kind === "stash"
              ? "stash"
              : "head";
    map.set(ref.name, { kind, label: ref.name });
  }
  return map;
});

function badges(commit: CommitNode): { kind: BadgeKind; label: string }[] {
  return commit.refs
    .filter((name) => name !== "HEAD")
    .map((name) => badgeByName.value.get(name) ?? { kind: "local", label: name });
}

function date(commit: CommitNode): string {
  const rel = relativeDate(commit.author.time, now.value);
  return rel.unit === "now" ? t("date.now") : t(`date.${rel.unit}`, { n: rel.n });
}

/** Asks for more rows when the scroll gets within 300px of the end. */
function onScroll(): void {
  const element = container.value;
  if (!element || !props.canLoadMore) return;
  if (element.scrollTop + element.clientHeight >= element.scrollHeight - 300) emit("loadMore");
}

watch(
  () => props.selectedIndex,
  (index) => {
    if (index >= 0 && index >= props.commits.length - 20 && props.canLoadMore) emit("loadMore");
  },
);

/* The selected row is the tab stop; before a selection exists, the first row is. */
const tabStop = computed(() => (props.selectedIndex >= 0 ? props.selectedIndex : 0));

defineExpose({ focus: navigation.focus });
</script>

<template>
  <div
    ref="container"
    role="listbox"
    class="min-h-0 flex-1 overflow-y-auto"
    data-testid="commit-rows"
    @keydown="navigation.onKeydown"
    @scroll.passive="onScroll"
  >
    <GraphRow
      v-for="(commit, index) in props.commits"
      :key="commit.hash"
      :data-index="index"
      :message="commit.subject"
      :author="commit.author.name"
      :date="date(commit)"
      :hash="shortHash(commit.hash)"
      :selected="index === props.selectedIndex"
      :tab-stop="index === tabStop"
      @select="emit('select', index)"
      @activate="emit('activate', index)"
    >
      <template v-if="badges(commit).length > 0" #refs>
        <RefBadge
          v-for="badge in badges(commit)"
          :key="badge.label"
          :kind="badge.kind"
          :label="badge.label"
        />
      </template>
    </GraphRow>
    <template v-if="props.loading">
      <SkeletonRow
        v-for="n in props.skeletonRows"
        :key="`skeleton-${n}`"
        :index="n"
        height="graph"
      />
    </template>
  </div>
</template>
