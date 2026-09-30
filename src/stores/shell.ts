// Shell layout state: layout mode, sidebar rail, pane sizes (persisted through the settings
// store), the narrow-window collapse of the review rail, the sidebar and the detail panel
// under the zoom, and the palette.

import { defineStore } from "pinia";
import { computed, ref } from "vue";

import {
  defaultColumnWidths,
  defaultSettings,
  useSettingsStore,
  type ColumnWidths,
  type LayoutMode,
  type PaneSizes,
} from "./settings";

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
 * sidebar starts as its rail and the detail panel gives way to the graph panel.
 */
export const NARROW_BREAKPOINT = 1024;
/** The sidebar's rail (`--rail-w`). */
const RAIL_WIDTH = 48;
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

export type SidebarTab = "repos" | "branches" | "worktrees";

/** The user's say on the review rail; "auto" follows the window width. */
export type ReviewRailPreference = "auto" | "shown" | "hidden";

/** The sidebar under the narrow breakpoint: its rail ("auto") until the user shows it. */
export type NarrowSidebar = "auto" | "shown";

export const useShellStore = defineStore("shell", () => {
  const settings = useSettingsStore();
  const windowWidth = ref(1440);
  const reviewRailPreference = ref<ReviewRailPreference>("auto");
  /** Session state, not a setting: a toggle while zoomed would otherwise hide the sidebar of
   * the next unzoomed launch. */
  const narrowSidebar = ref<NarrowSidebar>("auto");
  const paletteOpen = ref(false);
  /** Repos while nothing is open (the home screen); the shell switches to Branches on open. */
  const sidebarTab = ref<SidebarTab>("repos");

  const layoutMode = computed<LayoutMode>(() => settings.values.layoutMode);
  const narrow = computed(() => windowWidth.value < NARROW_BREAKPOINT);
  /** The remembered setting; under the narrow breakpoint the rail, until the user shows it. */
  const sidebarCollapsed = computed(() =>
    narrow.value ? narrowSidebar.value === "auto" : settings.values.sidebarCollapsed,
  );
  const paneSizes = computed<PaneSizes>(() => settings.values.paneSizes);
  const columnWidths = computed<ColumnWidths>(() => settings.values.columnWidths);

  /**
   * The detail panel's limits, for its divider as for its width: 360 to 900, and
   * under the narrow breakpoint 280 up to what leaves the graph panel 320px.
   */
  const detailLimits = computed(() => {
    if (!narrow.value) return paneLimits.detail;
    const side = sidebarCollapsed.value ? RAIL_WIDTH : paneSizes.value.sidebar;
    const room = windowWidth.value - side - NARROW_GRAPH_MIN;
    const max = Math.max(NARROW_DETAIL_MIN, Math.min(room, paneLimits.detail.max));
    return { min: NARROW_DETAIL_MIN, max };
  });

  /**
   * Width of the detail panel: the pinned size after a drag, else the fraction of the window.
   * Under the narrow breakpoint it leaves the graph panel 320px, down to 280px of its own, the
   * share taken of the window less what the sidebar or its rail takes.
   */
  const detailWidth = computed(() => {
    const pinned = paneSizes.value.detail;
    if (!narrow.value) {
      if (pinned !== null) return clampPane("detail", pinned);
      return defaultDetailWidth(windowWidth.value, paneSizes.value.sidebar);
    }
    const side = sidebarCollapsed.value ? RAIL_WIDTH : paneSizes.value.sidebar;
    const width = pinned ?? DETAIL_FRACTION * (windowWidth.value - side);
    const { min, max } = detailLimits.value;
    return Math.round(Math.min(Math.max(width, min), max));
  });

  /** The review rail follows the user's toggle, else it hides below the breakpoint. */
  const reviewRailCollapsed = computed(() => {
    if (layoutMode.value !== "review") return false;
    if (reviewRailPreference.value !== "auto") return reviewRailPreference.value === "hidden";
    return windowWidth.value < REVIEW_RAIL_BREAKPOINT;
  });

  function setLayoutMode(mode: LayoutMode): Promise<void> {
    return settings.update("layoutMode", mode);
  }

  /** ⌘B: under the narrow breakpoint it shows or hides the sidebar for the session only. */
  function toggleSidebar(): Promise<void> {
    if (narrow.value) {
      narrowSidebar.value = narrowSidebar.value === "auto" ? "shown" : "auto";
      return Promise.resolve();
    }
    return settings.update("sidebarCollapsed", !settings.values.sidebarCollapsed);
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
    if (px < NARROW_BREAKPOINT !== narrow.value) narrowSidebar.value = "auto";
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

  /**
   * The Worktrees tab shows the dashboard in the main area; the other tabs return to graph
   * focus when the dashboard is up (the review and compare layouts keep their tab).
   */
  function setSidebarTab(tab: SidebarTab): void {
    sidebarTab.value = tab;
    if (tab === "worktrees" && layoutMode.value !== "worktrees") {
      void setLayoutMode("worktrees");
    } else if (tab !== "worktrees" && layoutMode.value === "worktrees") {
      void setLayoutMode("graph");
    }
  }

  /** Expands the sidebar on `tab` (the rail icons do this); for the session when narrow. */
  async function expandSidebar(tab: SidebarTab): Promise<void> {
    setSidebarTab(tab);
    if (narrow.value) narrowSidebar.value = "shown";
    else if (settings.values.sidebarCollapsed) await settings.update("sidebarCollapsed", false);
  }

  return {
    windowWidth,
    sidebarTab,
    setSidebarTab,
    expandSidebar,
    layoutMode,
    sidebarCollapsed,
    paneSizes,
    detailWidth,
    detailLimits,
    reviewRailCollapsed,
    paletteOpen,
    setLayoutMode,
    toggleSidebar,
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
