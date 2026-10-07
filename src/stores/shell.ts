// Shell layout state: the layout shown (a comparison's tab's, else the project's tab's), the
// sidebar's open panel (its rail is the sidebar), pane sizes (persisted through the settings
// store), the narrow-window collapse of the review rail and of the detail panel under the zoom,
// and the palette.

import { defineStore } from "pinia";
import { computed, ref } from "vue";

import {
  defaultColumnWidths,
  defaultSettings,
  useSettingsStore,
  type ColumnWidths,
  type LayoutMode,
  type PaneSizes,
  type ProjectLayout,
} from "./settings";
import { useTabsStore } from "./tabs";

/** The sections of the sidebar, each a panel of the rail, in the rail's order. */
export const sidebarSectionIds = ["repos", "local", "remote", "tags", "worktrees"] as const;
export type SidebarSectionId = (typeof sidebarSectionIds)[number];

/**
 * Why a sidebar panel closed, which says where the focus goes: a press gives it to what it
 * pressed and a move of the focus already took it; any other way (⌘B, a row's activation, the
 * dashboard) gives it back to where it was before the panel opened, else the layout's list.
 */
export type SidebarCloseReason = "press" | "focus" | "other";

/** Pane limits in px, from the design: detail never under 360, sidebar 240 by default. */
export const paneLimits: Record<keyof PaneSizes, { min: number; max: number }> = {
  sidebar: { min: 200, max: 420 },
  detail: { min: 360, max: 900 },
  files: { min: 220, max: 560 },
  reviewRail: { min: 240, max: 400 },
};

/** Limits of a table column in px; the last column takes what is left. */
export const columnLimits = { min: 60, max: 480 };

export type ColumnTable = keyof ColumnWidths;

/** Below this window width the review rail collapses. */
export const REVIEW_RAIL_BREAKPOINT = 1100;

/**
 * Below this page width, which only the zoom reaches (the window's minimum is 1024), the
 * detail panel gives way to the graph panel.
 */
export const NARROW_BREAKPOINT = 1024;
/** The sidebar's rail (`--rail-w`): all the room the sidebar takes, its panels floating. */
const RAIL_WIDTH = 48;
/** The room the detail panel's default share leaves the sidebar, as the frames measure it. */
const SIDEBAR_SHARE = 240;
/** Under the narrow breakpoint: the width the detail panel leaves the graph panel (its lanes,
 * a subject and the time), and the detail panel's own floor (the summary and the file names). */
const NARROW_GRAPH_MIN = 320;
const NARROW_DETAIL_MIN = 280;

export function clampPane(pane: keyof PaneSizes, px: number): number {
  const { min, max } = paneLimits[pane];
  return Math.round(Math.min(Math.max(px, min), max));
}

/** Share of the window (minus the sidebar) the detail panel takes until the user drags it. */
export const DETAIL_FRACTION = 0.4;

/** The default detail width: 480 at 1440, 416 at 1280, never under 360. */
export function defaultDetailWidth(windowWidth: number, sidebarWidth: number): number {
  return clampPane("detail", DETAIL_FRACTION * (windowWidth - sidebarWidth));
}

/** The user's say on the review rail; "auto" follows the window width. */
export type ReviewRailPreference = "auto" | "shown" | "hidden";

/** No filter in any panel. */
const noFilters = (): Record<SidebarSectionId, string> => ({
  repos: "",
  local: "",
  remote: "",
  tags: "",
  worktrees: "",
});

export const useShellStore = defineStore("shell", () => {
  const settings = useSettingsStore();
  const tabs = useTabsStore();
  const windowWidth = ref(1440);
  const reviewRailPreference = ref<ReviewRailPreference>("auto");
  const paletteOpen = ref(false);
  /**
   * The sidebar's open panel, floating over the main area; none open by default. Session state,
   * not a setting: a panel open at start would cover the graph.
   */
  const sidebarPanel = ref<SidebarSectionId | null>(null);
  /** The panel ⌘B opens: the last one opened, Branches until one is. */
  const lastSidebarPanel = ref<SidebarSectionId>("local");
  /** Why the panel last closed (`SidebarCloseReason`), read by whoever places the focus. */
  const sidebarCloseReason = ref<SidebarCloseReason>("other");
  /** Each panel's filter, kept while it is closed; cleared when another repository shows. */
  const sidebarFilters = ref<Record<SidebarSectionId, string>>(noFilters());

  /** The layout shown: the comparison while its tab shows, else the project's tab's. */
  const layoutMode = computed<LayoutMode>(() =>
    tabs.activePair ? "compare" : settings.values.layoutMode,
  );
  const narrow = computed(() => windowWidth.value < NARROW_BREAKPOINT);
  const paneSizes = computed<PaneSizes>(() => settings.values.paneSizes);
  const columnWidths = computed<ColumnWidths>(() => settings.values.columnWidths);

  /**
   * The detail panel's limits, for its divider as for its width: 360 to 900, and
   * under the narrow breakpoint 280 up to what leaves the graph panel 320px.
   */
  const detailLimits = computed(() => {
    if (!narrow.value) return paneLimits.detail;
    const room = windowWidth.value - RAIL_WIDTH - NARROW_GRAPH_MIN;
    const max = Math.max(NARROW_DETAIL_MIN, Math.min(room, paneLimits.detail.max));
    return { min: NARROW_DETAIL_MIN, max };
  });

  /**
   * Width of the detail panel: the pinned size after a drag, else the fraction of the window.
   * Under the narrow breakpoint it leaves the graph panel 320px, down to 280px of its own, the
   * share taken of the window less the rail.
   */
  const detailWidth = computed(() => {
    const pinned = paneSizes.value.detail;
    if (!narrow.value) {
      if (pinned !== null) return clampPane("detail", pinned);
      return defaultDetailWidth(windowWidth.value, SIDEBAR_SHARE);
    }
    const width = pinned ?? DETAIL_FRACTION * (windowWidth.value - RAIL_WIDTH);
    const { min, max } = detailLimits.value;
    return Math.round(Math.min(Math.max(width, min), max));
  });

  /** The review rail follows the user's toggle, else it hides below the breakpoint. */
  const reviewRailCollapsed = computed(() => {
    if (layoutMode.value !== "review") return false;
    if (reviewRailPreference.value !== "auto") return reviewRailPreference.value === "hidden";
    return windowWidth.value < REVIEW_RAIL_BREAKPOINT;
  });

  /** Shows the project's tab with `mode`; the comparison's tab, if one showed, stays. */
  function setLayoutMode(mode: ProjectLayout): Promise<void> {
    tabs.showProject();
    return settings.update("layoutMode", mode);
  }

  /** Opens a sidebar panel over the main area; the next ⌘B opens it again. */
  function openSidebarPanel(id: SidebarSectionId): void {
    sidebarPanel.value = id;
    lastSidebarPanel.value = id;
  }

  function closeSidebarPanel(reason: SidebarCloseReason = "other"): void {
    if (sidebarPanel.value === null) return;
    sidebarCloseReason.value = reason;
    sidebarPanel.value = null;
  }

  /** ⌘B's panel when the last one is not offered (Repositories in a project of one). */
  function forgetSidebarPanel(id: SidebarSectionId): void {
    if (lastSidebarPanel.value === id) lastSidebarPanel.value = "local";
  }

  /**
   * A rail icon (`id`): opens its panel, or closes it when it is the open one. ⌘B (no `id`):
   * closes the open panel, or opens the last one.
   */
  function toggleSidebarPanel(id?: SidebarSectionId): void {
    if (sidebarPanel.value !== null && (id === undefined || sidebarPanel.value === id)) {
      closeSidebarPanel();
    } else {
      openSidebarPanel(id ?? lastSidebarPanel.value);
    }
  }

  function setSidebarFilter(id: SidebarSectionId, value: string): void {
    sidebarFilters.value = { ...sidebarFilters.value, [id]: value };
  }

  function clearSidebarFilters(): void {
    sidebarFilters.value = noFilters();
  }

  /**
   * Sets a pane to `px` within its limits; for the detail panel this pins the width, within the
   * narrow limits while zoomed (a width under 360 shows as 360 again at normal widths).
   */
  function setPaneSize(pane: keyof PaneSizes, px: number): Promise<void> {
    const next: PaneSizes = { ...settings.values.paneSizes };
    if (pane === "detail" && narrow.value) {
      const { min, max } = detailLimits.value;
      next.detail = Math.round(Math.min(Math.max(px, min), max));
    } else {
      next[pane] = clampPane(pane, px);
    }
    return settings.update("paneSizes", next);
  }

  /** Puts a pane back to its default; the detail panel unpins, back to its share of the window. */
  function resetPaneSize(pane: keyof PaneSizes): Promise<void> {
    const defaults = defaultSettings(settings.platform).paneSizes;
    const next: PaneSizes = { ...settings.values.paneSizes };
    if (pane === "detail") next.detail = defaults.detail;
    else next[pane] = defaults[pane];
    return settings.update("paneSizes", next);
  }

  /** Sets a table column to `px` within the column limits. */
  function setColumnWidth<T extends ColumnTable>(
    table: T,
    column: keyof ColumnWidths[T],
    px: number,
  ): Promise<void> {
    const width = Math.round(Math.min(Math.max(px, columnLimits.min), columnLimits.max));
    const current = settings.values.columnWidths;
    return settings.update("columnWidths", {
      ...current,
      [table]: { ...current[table], [column]: width },
    });
  }

  /** Puts a table column back to its default width. */
  function resetColumnWidth<T extends ColumnTable>(
    table: T,
    column: keyof ColumnWidths[T],
  ): Promise<void> {
    const width = defaultColumnWidths()[table][column] as number;
    return setColumnWidth(table, column, width);
  }

  /** Crossing a breakpoint in either direction hands its rail back to the automatic rule. */
  function setWindowWidth(px: number): void {
    const railNarrow = px < REVIEW_RAIL_BREAKPOINT;
    if (railNarrow !== windowWidth.value < REVIEW_RAIL_BREAKPOINT) {
      reviewRailPreference.value = "auto";
    }
    windowWidth.value = px;
  }

  function showReviewRail(): void {
    reviewRailPreference.value = "shown";
  }

  function hideReviewRail(): void {
    reviewRailPreference.value = "hidden";
  }

  function openPalette(): void {
    paletteOpen.value = true;
  }

  function closePalette(): void {
    paletteOpen.value = false;
  }

  function togglePalette(): void {
    paletteOpen.value = !paletteOpen.value;
  }

  return {
    windowWidth,
    sidebarPanel,
    lastSidebarPanel,
    sidebarCloseReason,
    sidebarFilters,
    openSidebarPanel,
    closeSidebarPanel,
    forgetSidebarPanel,
    toggleSidebarPanel,
    setSidebarFilter,
    clearSidebarFilters,
    layoutMode,
    paneSizes,
    detailWidth,
    detailLimits,
    reviewRailCollapsed,
    paletteOpen,
    setLayoutMode,
    setPaneSize,
    resetPaneSize,
    columnWidths,
    setColumnWidth,
    resetColumnWidth,
    setWindowWidth,
    showReviewRail,
    hideReviewRail,
    openPalette,
    closePalette,
    togglePalette,
  };
});
