// Shell layout state: layout mode, sidebar rail, pane sizes (persisted through the settings
// store), the narrow-window collapse of the review rail, and the palette.

import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { useSettingsStore, type LayoutMode, type PaneSizes } from "./settings";

/** Pane limits in px, from the design: detail never under 360, sidebar 240 by default. */
export const paneLimits: Record<keyof PaneSizes, { min: number; max: number }> = {
  sidebar: { min: 200, max: 420 },
  detail: { min: 360, max: 900 },
  files: { min: 220, max: 420 },
  reviewRail: { min: 240, max: 400 },
};

/** Below this window width the review rail collapses. */
export const REVIEW_RAIL_BREAKPOINT = 1100;

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

export const useShellStore = defineStore("shell", () => {
  const settings = useSettingsStore();
  const windowWidth = ref(1440);
  const reviewRailPreference = ref<ReviewRailPreference>("auto");
  const paletteOpen = ref(false);
  /** Repos while nothing is open (the home screen); the shell switches to Branches on open. */
  const sidebarTab = ref<SidebarTab>("repos");

  const layoutMode = computed<LayoutMode>(() => settings.values.layoutMode);
  const sidebarCollapsed = computed(() => settings.values.sidebarCollapsed);
  const paneSizes = computed<PaneSizes>(() => settings.values.paneSizes);

  /** Width of the detail panel: the pinned size after a drag, else the fraction of the window. */
  const detailWidth = computed(() => {
    const pinned = paneSizes.value.detail;
    if (pinned !== null) return clampPane("detail", pinned);
    return defaultDetailWidth(windowWidth.value, paneSizes.value.sidebar);
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

  function toggleSidebar(): Promise<void> {
    return settings.update("sidebarCollapsed", !settings.values.sidebarCollapsed);
  }

  /** Sets a pane to `px` within its limits; for the detail panel this pins the width. */
  function setPaneSize(pane: keyof PaneSizes, px: number): Promise<void> {
    const next: PaneSizes = { ...settings.values.paneSizes };
    next[pane] = clampPane(pane, px);
    return settings.update("paneSizes", next);
  }

  /** Crossing the breakpoint in either direction hands the rail back to the automatic rule. */
  function setWindowWidth(px: number): void {
    const narrow = px < REVIEW_RAIL_BREAKPOINT;
    if (narrow !== windowWidth.value < REVIEW_RAIL_BREAKPOINT) reviewRailPreference.value = "auto";
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

  /** Expands the sidebar on `tab` (the rail icons do this). */
  async function expandSidebar(tab: SidebarTab): Promise<void> {
    setSidebarTab(tab);
    if (settings.values.sidebarCollapsed) await settings.update("sidebarCollapsed", false);
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
    reviewRailCollapsed,
    paletteOpen,
    setLayoutMode,
    toggleSidebar,
    setPaneSize,
    setWindowWidth,
    showReviewRail,
    hideReviewRail,
    openPalette,
    closePalette,
    togglePalette,
  };
});
