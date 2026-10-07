// The tabs of the open project: its own tab, which shows the layout the top bar and ⌘1 to ⌘4
// choose, and a tab for each comparison the user opened, two endpoints the comparison recomputes
// when its tab shows. Each project's comparisons are remembered in the settings (`tabs`) with the
// tab it showed: another project shows its own tab first, and a launch shows the tab the window
// was closed on.

import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { useSettingsStore, type CompareEndpoint, type CompareEndpoints } from "./settings";

/** A comparison's tab: its endpoints, and an id unique in the session. */
export interface ComparisonTab extends CompareEndpoints {
  id: number;
}

/** Whether two pairs compare the same A with the same B. */
function samePair(one: CompareEndpoints, other: CompareEndpoints): boolean {
  return one.a.rev === other.a.rev && one.b.rev === other.b.rev;
}

export const useTabsStore = defineStore("tabs", () => {
  const settings = useSettingsStore();
  const comparisons = ref<ComparisonTab[]>([]);
  /** The comparison whose tab shows; null shows the project's tab. */
  const activeId = ref<number | null>(null);
  let nextId = 1;

  const active = computed(() => comparisons.value.find((tab) => tab.id === activeId.value) ?? null);
  /** The endpoints of the comparison shown, null on the project's tab. */
  const activePair = computed<CompareEndpoints | null>(() =>
    active.value ? { a: active.value.a, b: active.value.b } : null,
  );
  /** The tab shown as an index of the row: 0 for the project's tab, n for the n-th comparison. */
  const activeIndex = computed(() =>
    activeId.value === null
      ? 0
      : comparisons.value.findIndex((tab) => tab.id === activeId.value) + 1,
  );

  function tabOf(pair: CompareEndpoints): ComparisonTab {
    return { id: nextId++, a: pair.a, b: pair.b };
  }

  /** Shows the comparison of `a` with `b`: its tab when one is open, else a new one after the
   * tab shown. */
  function openComparison(a: CompareEndpoint, b: CompareEndpoint): void {
    const pair = { a, b };
    const open = comparisons.value.find((tab) => samePair(tab, pair));
    if (open) {
      activeId.value = open.id;
      return;
    }
    const tab = tabOf(pair);
    const list = [...comparisons.value];
    list.splice(activeIndex.value, 0, tab);
    comparisons.value = list;
    activeId.value = tab.id;
  }

  /**
   * Changes the comparison of the tab shown (an endpoint picked again, or the swap); a pair
   * another tab compares already shows that tab instead, the edited one closing.
   */
  function setPair(a: CompareEndpoint, b: CompareEndpoint): void {
    const id = activeId.value;
    if (id === null) return;
    const pair = { a, b };
    const other = comparisons.value.find((tab) => tab.id !== id && samePair(tab, pair));
    if (other) {
      comparisons.value = comparisons.value.filter((tab) => tab.id !== id);
      activeId.value = other.id;
      return;
    }
    comparisons.value = comparisons.value.map((tab) => (tab.id === id ? { id, a, b } : tab));
  }

  function showProject(): void {
    activeId.value = null;
  }

  /** Shows the tab at `index` of the row (0, the project's). */
  function showIndex(index: number): void {
    activeId.value = index <= 0 ? null : (comparisons.value[index - 1]?.id ?? activeId.value);
  }

  /** The next (1) or previous (-1) tab, round the row. */
  function step(by: 1 | -1): void {
    const count = comparisons.value.length + 1;
    if (count < 2) return;
    showIndex((activeIndex.value + by + count) % count);
  }

  /** Closes a comparison's tab; closing the one shown shows the tab before it. */
  function close(id: number): void {
    const index = comparisons.value.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const wasActive = activeId.value === id;
    comparisons.value = comparisons.value.filter((tab) => tab.id !== id);
    if (wasActive) showIndex(index);
  }

  /** ⌘W: closes the comparison shown; false on the project's tab, which never closes. */
  function closeActive(): boolean {
    if (activeId.value === null) return false;
    close(activeId.value);
    return true;
  }

  // --- Per project ---------------------------------------------------------------------------

  /** The project whose tabs these are; null without one, whose comparisons are not kept. */
  let project: number | null = null;

  function load(id: number | null, showStored: boolean): void {
    project = id;
    const stored = id === null ? undefined : settings.values.tabs[String(id)];
    comparisons.value = (stored?.comparisons ?? []).map(tabOf);
    activeId.value = null;
    if (showStored && stored) showIndex(stored.active);
  }

  function save(): void {
    if (project === null) return;
    const key = String(project);
    const entry = {
      comparisons: comparisons.value.map(({ a, b }) => ({ a, b })),
      active: activeIndex.value,
    };
    const all = { ...settings.values.tabs };
    if (entry.comparisons.length === 0) delete all[key];
    else all[key] = entry;
    if (JSON.stringify(all) !== JSON.stringify(settings.values.tabs)) {
      void settings.update("tabs", all);
    }
  }

  /** Drops the tabs of projects that no longer exist. */
  function prune(ids: readonly number[]): void {
    const kept = Object.fromEntries(
      Object.entries(settings.values.tabs).filter(([key]) => ids.includes(Number(key))),
    );
    if (Object.keys(kept).length !== Object.keys(settings.values.tabs).length) {
      void settings.update("tabs", kept);
    }
  }

  // The launch shows the tab the window was closed on; another project, its own tab.
  let launched = false;
  watch(
    () => [settings.loaded, settings.values.activeProject] as const,
    ([loaded, id]) => {
      if (!loaded) return;
      if (launched && id === project) return;
      load(id, !launched);
      launched = true;
    },
    { immediate: true },
  );

  watch([comparisons, activeId], save, { deep: true });

  return {
    comparisons,
    activeId,
    active,
    activePair,
    activeIndex,
    openComparison,
    setPair,
    showProject,
    showIndex,
    step,
    close,
    closeActive,
    prune,
  };
});
