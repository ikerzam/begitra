<script setup lang="ts">
// The Branches tab: local branches, remote branches and tags, filtered, with roving focus and
// j/k navigation. Selecting a branch scopes the graph to it (the selection lives in the graph
// store, so the scope control and the list agree); nothing is selected until the user picks a
// row, and the first row is the tab stop until then. Lane colours come from the shared map, so
// they survive filtering. While a filter is typed, the count line reads "N of M branches".

import { Tag } from "@lucide/vue";
import { computed, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";

import BranchContextMenu from "@/branches/BranchContextMenu.vue";
import type { BranchAction } from "@/branches/useBranchActions";
import ListRow from "@/components/ListRow.vue";
import SkeletonRow from "@/components/SkeletonRow.vue";
import type { Ref as GitRef } from "@/ipc/schemas";
import { matchesQuery } from "@/palette/usePalette";
import { useListNavigation } from "@/shortcuts/useListNavigation";
import { useGraphStore } from "@/stores/graph";
import { useRepoStore } from "@/stores/repo";
import { useSettingsStore } from "@/stores/settings";

import { branchLanes } from "./branchLanes";
import { sortRefs } from "./branchOrder";

const props = defineProps<{ filter: string }>();
const emit = defineEmits<{ action: [kind: BranchAction, ref: GitRef] }>();

const { t } = useI18n();
const repo = useRepoStore();
const graph = useGraphStore();
const settings = useSettingsStore();
const listbox = ref<HTMLElement | null>(null);
const menu = ref<{ ref: GitRef; x: number; y: number } | null>(null);
const currentName = computed(() => repo.currentBranch?.name ?? null);

interface BranchRow {
  ref: GitRef;
  lane: number;
}

interface BranchGroup {
  id: "local" | "remote" | "tags";
  label: string;
  rows: BranchRow[];
}

const groups = computed<BranchGroup[]>(() => {
  const lanes = branchLanes(repo.refs);
  const matching = repo.refs.filter((r) => matchesQuery(r.name, props.filter));
  const pick = (kind: GitRef["kind"]) =>
    sortRefs(
      matching.filter((r) => r.kind === kind),
      settings.values.branchSort,
    ).map((r) => ({ ref: r, lane: lanes.get(r.fullName) ?? 0 }));
  const all: BranchGroup[] = [
    { id: "local", label: t("sidebar.local"), rows: pick("local-branch") },
    { id: "remote", label: t("sidebar.remote"), rows: pick("remote-branch") },
    { id: "tags", label: t("sidebar.tags"), rows: pick("tag") },
  ];
  return all.filter((group) => group.rows.length > 0);
});

const flatRows = computed(() => groups.value.flatMap((group) => group.rows));
const rowCount = computed(() => flatRows.value.length);

/* The selection is the graph's scope ref, so filtering keeps it; none until the user picks a row.
   A move waits a moment before scoping the graph, so that j/k held over the list restarts the
   walk once, on the row the user stops at; the row itself is marked at once. */
const SCOPE_DELAY_MS = 120;
const pendingName = ref<string | null>(null);
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

const selectedName = computed(() => {
  if (pendingName.value !== null) return pendingName.value;
  const scope = graph.filters.scope;
  return scope.kind === "ref" ? scope.fullName : null;
});
const selectedRow = computed({
  get: () => flatRows.value.findIndex((row) => row.ref.fullName === selectedName.value),
  set: (index: number) => {
    const ref = flatRows.value[index]?.ref;
    if (!ref) return;
    pendingName.value = ref.fullName;
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      pendingName.value = null;
      graph.setScope({ kind: "ref", name: ref.name, fullName: ref.fullName });
    }, SCOPE_DELAY_MS);
  },
});

onUnmounted(() => {
  if (pendingTimer !== null) clearTimeout(pendingTimer);
});

/** "N of M branches" while a filter narrows the list. */
const countLine = computed(() => {
  if (props.filter.trim() === "") return "";
  const total = repo.refs.filter((r) => r.kind !== "stash").length;
  return t("sidebar.branchCount", { n: rowCount.value, m: total });
});
const tabStopRow = computed(() => Math.max(0, selectedRow.value));

const rowElement = (index: number) => listbox.value?.querySelector(`[data-index="${index}"]`);
const navigation = useListNavigation({
  count: rowCount,
  selected: selectedRow,
  rowElement,
  onActivate: (index) => {
    const ref = flatRows.value[index]?.ref;
    if (ref && !ref.isCurrent) emit("action", "checkout", ref);
  },
});

/** The menu opens under the row, past the lane dot, where the graph opens its own. */
const MENU_OFFSET_X = 116;

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    const ref = flatRows.value[selectedRow.value]?.ref;
    if (!ref) return;
    event.preventDefault();
    const rect = rowElement(selectedRow.value)?.getBoundingClientRect();
    menu.value = { ref, x: rect ? rect.left + MENU_OFFSET_X : 0, y: rect ? rect.bottom : 0 };
    return;
  }
  navigation.onKeydown(event);
}

function onContextMenu(index: number, event: MouseEvent): void {
  event.preventDefault();
  navigation.select(index);
  const ref = flatRows.value[index]?.ref;
  if (ref) menu.value = { ref, x: event.clientX, y: event.clientY };
}

function closeMenu(): void {
  menu.value = null;
  navigation.focus();
}

/** The menu's choice: closed first, then reported with its ref. */
function choose(kind: BranchAction): void {
  const target = menu.value?.ref;
  menu.value = null;
  if (target) emit("action", kind, target);
}

function rowIndex(groupIndex: number, index: number): number {
  let offset = 0;
  for (let i = 0; i < groupIndex; i += 1) offset += groups.value[i]?.rows.length ?? 0;
  return offset + index;
}

defineExpose({ focus: navigation.focus });
</script>

<template>
  <div
    id="sidebar-branches"
    ref="listbox"
    role="listbox"
    :aria-label="t('sidebar.branches')"
    class="min-h-0 flex-1 overflow-y-auto pb-2"
    data-testid="branch-list"
    @keydown="onKeydown"
  >
    <template v-for="(group, groupIndex) in groups" :key="group.id">
      <p class="px-3 pt-3 pb-1 text-sm text-fg-muted">{{ group.label }}</p>
      <ListRow
        v-for="(row, index) in group.rows"
        :key="row.ref.fullName"
        :data-index="rowIndex(groupIndex, index)"
        :name="row.ref.name"
        :lane="row.lane"
        :icon="group.id === 'tags' ? Tag : undefined"
        :ahead="row.ref.upstream ? (row.ref.ahead ?? undefined) : undefined"
        :behind="row.ref.upstream ? (row.ref.behind ?? undefined) : undefined"
        :selected="rowIndex(groupIndex, index) === selectedRow"
        :tab-stop="rowIndex(groupIndex, index) === tabStopRow"
        @select="navigation.select(rowIndex(groupIndex, index))"
        @contextmenu="(event: MouseEvent) => onContextMenu(rowIndex(groupIndex, index), event)"
      />
    </template>
    <p v-if="countLine" class="px-3 pt-3 text-sm text-fg-muted" data-testid="branch-count">
      {{ countLine }}
    </p>
    <BranchContextMenu
      v-if="menu"
      :target="menu.ref"
      :current="currentName"
      :x="menu.x"
      :y="menu.y"
      @close="closeMenu"
      @checkout="choose('checkout')"
      @create-here="choose('createHere')"
      @merge="choose('merge')"
      @rebase="choose('rebase')"
      @compare="choose('compare')"
      @rename="choose('rename')"
      @set-upstream="choose('setUpstream')"
      @push="choose('push')"
      @delete="choose('delete')"
      @delete-tag="choose('deleteTag')"
    />
    <template v-if="groups.length === 0 && repo.state.kind === 'ready' && !repo.refsLoaded">
      <SkeletonRow v-for="n in 6" :key="n" :index="n" height="list" />
    </template>
    <p v-else-if="groups.length === 0" class="px-3 py-4 text-md text-fg-secondary">
      {{ repo.state.kind === "ready" ? t("sidebar.noBranches") : t("sidebar.noRepository") }}
    </p>
  </div>
</template>
