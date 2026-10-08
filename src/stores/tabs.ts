// The tabs of the window, for the open project or, with none, for Home. A project's row starts
// with its fixed tabs (Graph, Review, Changes, and the Overview while it holds more than one
// repository), which never close; Home's with Home's own. After them come the tabs opened on
// demand, each closable: one per comparison, the worktrees dashboard and the settings. A new tab
// opens right after the tab shown, or right after the fixed tabs while one of those shows. Each
// project's open tabs and the tab it showed are remembered in the settings (`tabs`): opening a
// project shows its Graph tab, and a launch shows the tab the window was closed on.

import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";

import { useProjectsStore } from "./projects";
import { useRepoStore } from "./repo";
import {
  useSettingsStore,
  type CompareEndpoint,
  type CompareEndpoints,
  type ProjectLayout,
  type ProjectTabs,
  type StoredTab,
} from "./settings";

/** The tabs a project always has, in the row's order. */
export const fixedTabKinds = ["graph", "review", "changes", "overview"] as const;
export type FixedTabKind = (typeof fixedTabKinds)[number];

/** A tab opened on demand, with an id unique in the session. */
export type OpenTab =
  | ({ id: number; kind: "compare" } & CompareEndpoints)
  | { id: number; kind: "worktrees" }
  | { id: number; kind: "settings" };

/** A tab of the row: a fixed one or Home's by its kind, one opened on demand by its id. */
export type TabKey = FixedTabKind | "home" | number;

/** What a tab shows. */
export type TabKind = FixedTabKind | "home" | OpenTab["kind"];

export interface RowTab {
  key: TabKey;
  kind: TabKind;
  /** The tab opened on demand; null for a fixed tab and Home's, which never close. */
  open: OpenTab | null;
}

/** Whether two pairs compare the same A with the same B. */
function samePair(one: CompareEndpoints, other: CompareEndpoints): boolean {
  return one.a.rev === other.a.rev && one.b.rev === other.b.rev;
}

const isFixed = (kind: string): kind is FixedTabKind =>
  (fixedTabKinds as readonly string[]).includes(kind);

export const useTabsStore = defineStore("tabs", () => {
  const settings = useSettingsStore();
  /** The open project, whose tabs these are; null at Home. */
  const context = ref<number | null>(null);
  const open = ref<OpenTab[]>([]);
  const activeKey = ref<TabKey>("home");
  let nextId = 1;

  /** Home: no project open, and no repository open outside one. The repository store is read
   * when this is, as the projects store is below: both need this one to be set up. */
  const atHome = computed(() => context.value === null && useRepoStore().state.kind === "empty");

  /** The row: the fixed tabs (the Overview while the project holds several repositories), or
   * Home's, then the tabs opened on demand. */
  const row = computed<RowTab[]>(() => {
    const fixed: RowTab[] = atHome.value
      ? [{ key: "home", kind: "home", open: null }]
      : fixedTabKinds
          .filter((kind) => kind !== "overview" || useProjectsStore().multi)
          .map((kind) => ({ key: kind, kind, open: null }));
    return [...fixed, ...open.value.map((tab) => ({ key: tab.id, kind: tab.kind, open: tab }))];
  });

  /** The tab shown as an index of the row; -1 while it is not in the row (an Overview the
   * project's members no longer offer, until the shell shows the graph). */
  const activeIndex = computed(() => row.value.findIndex((tab) => tab.key === activeKey.value));
  /** The open tab shown; null on a fixed tab or Home's. */
  const active = computed(() =>
    typeof activeKey.value === "number"
      ? (open.value.find((tab) => tab.id === activeKey.value) ?? null)
      : null,
  );
  /** What the tab shown shows. */
  const activeKind = computed<TabKind>(() =>
    typeof activeKey.value === "number" ? (active.value?.kind ?? "graph") : activeKey.value,
  );
  /** The endpoints of the comparison shown, null elsewhere. */
  const activePair = computed<CompareEndpoints | null>(() =>
    active.value?.kind === "compare" ? { a: active.value.a, b: active.value.b } : null,
  );
  /** The comparisons' tabs, in the row's order. */
  const comparisons = computed(() =>
    open.value.filter(
      (tab): tab is Extract<OpenTab, { kind: "compare" }> => tab.kind === "compare",
    ),
  );

  /** Opens `tab` right after the tab shown, or right after the fixed tabs while one shows. */
  function insert(tab: OpenTab): void {
    const shown = activeKey.value;
    const at = typeof shown === "number" ? open.value.findIndex((t) => t.id === shown) + 1 : 0;
    const list = [...open.value];
    list.splice(at, 0, tab);
    open.value = list;
    activeKey.value = tab.id;
  }

  /**
   * Shows the tab of `kind`: a fixed one, or the dashboard's or the settings', opened first when
   * missing. At Home the project's views show Home, and the settings open beside it.
   */
  function show(kind: ProjectLayout): void {
    if (atHome.value && kind !== "settings") {
      activeKey.value = "home";
      return;
    }
    if (isFixed(kind)) {
      activeKey.value = kind;
      return;
    }
    const existing = open.value.find((tab) => tab.kind === kind);
    if (existing) activeKey.value = existing.id;
    else insert({ id: nextId++, kind });
  }

  /** Shows the comparison of `a` with `b`: its tab when one is open, else a new one. */
  function openComparison(a: CompareEndpoint, b: CompareEndpoint): void {
    const pair = { a, b };
    const existing = comparisons.value.find((tab) => samePair(tab, pair));
    if (existing) activeKey.value = existing.id;
    else insert({ id: nextId++, kind: "compare", a, b });
  }

  /**
   * Changes the comparison of the tab shown (an endpoint picked again, or the swap); a pair
   * another tab compares already shows that tab instead, the edited one closing.
   */
  function setPair(a: CompareEndpoint, b: CompareEndpoint): void {
    const shown = active.value;
    if (shown?.kind !== "compare") return;
    const pair = { a, b };
    const other = comparisons.value.find((tab) => tab.id !== shown.id && samePair(tab, pair));
    if (other) {
      open.value = open.value.filter((tab) => tab.id !== shown.id);
      activeKey.value = other.id;
      return;
    }
    open.value = open.value.map((tab) => (tab.id === shown.id ? { ...shown, a, b } : tab));
  }

  /** Shows the tab at `index` of the row, the first one below it. */
  function showIndex(index: number): void {
    const tab = row.value[Math.max(index, 0)];
    if (tab) activeKey.value = tab.key;
  }

  /** The next (1) or previous (-1) tab, round the row. */
  function step(by: 1 | -1): void {
    const count = row.value.length;
    if (count < 2) return;
    const from = Math.max(activeIndex.value, 0);
    showIndex((from + by + count) % count);
  }

  /** Closes a tab opened on demand; closing the one shown shows the tab before it. */
  function close(id: number): void {
    const index = row.value.findIndex((tab) => tab.key === id);
    if (index < 0) return;
    const wasActive = activeKey.value === id;
    open.value = open.value.filter((tab) => tab.id !== id);
    if (wasActive) showIndex(index - 1);
  }

  /** ⌘W: closes the tab shown; false on a fixed tab or Home's, which never close. */
  function closeActive(): boolean {
    const shown = activeKey.value;
    if (typeof shown !== "number") return false;
    close(shown);
    return true;
  }

  // --- Per project ---------------------------------------------------------------------------

  function tabOf(stored: StoredTab): OpenTab {
    return { id: nextId++, ...stored };
  }

  /** The launch shows the tab of the layout an earlier version's project tab showed: a fixed
   * tab, or the dashboard or the settings opened after the others. */
  function showLaunchLayout(layout: ProjectLayout | null): void {
    if (layout === null) return;
    if (isFixed(layout)) {
      activeKey.value = layout;
      return;
    }
    const existing = open.value.find((tab) => tab.kind === layout);
    const tab = existing ?? tabOf({ kind: layout });
    if (!existing) open.value = [...open.value, tab];
    activeKey.value = tab.id;
  }

  /**
   * Shows the tabs of `id`, or Home's: its Graph tab, or at launch the tab it showed. The first
   * project shown takes the layout an earlier version left its one tab on (`launchLayout`): the
   * open project at launch, or the one the step of a version before projects opens.
   */
  function load(id: number | null, launch: boolean): void {
    context.value = id;
    const stored = id === null ? undefined : settings.values.tabs[String(id)];
    open.value = (stored?.open ?? []).map(tabOf);
    activeKey.value = id === null ? "home" : "graph";
    if (id === null) {
      // Left at Home, with no project the step of a version before projects will open: the
      // layout belongs to no project.
      if (launch && settings.legacy === null) settings.takeLaunchLayout();
      return;
    }
    const shown = stored?.active;
    const layout = settings.takeLaunchLayout();
    if (shown === undefined || shown === "project") showLaunchLayout(layout);
    else if (!launch) return;
    else if (typeof shown === "number") activeKey.value = open.value[shown]?.id ?? "graph";
    else activeKey.value = shown;
  }

  /** The tab shown as the settings keep it: a fixed tab's kind, or an open tab's place. */
  function storedActive(): ProjectTabs["active"] {
    const shown = activeKey.value;
    if (typeof shown !== "number") return shown === "home" ? "graph" : shown;
    return Math.max(
      open.value.findIndex((tab) => tab.id === shown),
      0,
    );
  }

  function save(): void {
    const id = context.value;
    if (id === null) return;
    const key = String(id);
    const entry: ProjectTabs = {
      open: open.value.map((tab): StoredTab => {
        if (tab.kind === "compare") return { kind: "compare", a: tab.a, b: tab.b };
        return { kind: tab.kind };
      }),
      active: storedActive(),
    };
    const all = { ...settings.values.tabs };
    if (entry.open.length === 0 && entry.active === "graph") delete all[key];
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

  // The launch shows the tab the window was closed on; another project, its Graph tab. At once,
  // so a view asked for right after the project changes is the new project's.
  let launched = false;
  watch(
    () => [settings.loaded, settings.values.activeProject] as const,
    ([loaded, id]) => {
      if (!loaded) return;
      if (launched && id === context.value) return;
      // The project left keeps its tabs as they are now: its save would run after the load.
      if (launched) save();
      load(id, !launched);
      launched = true;
    },
    { immediate: true, flush: "sync" },
  );

  watch([open, activeKey], save, { deep: true });

  return {
    row,
    open,
    activeKey,
    active,
    activeKind,
    activePair,
    activeIndex,
    comparisons,
    show,
    openComparison,
    setPair,
    showIndex,
    step,
    close,
    closeActive,
    prune,
  };
});
