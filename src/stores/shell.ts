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

export const useShellStore = defineStore("shell", () => {
  const settings = useSettingsStore();
  const windowWidth = ref(1440);
  const reviewRailShown = ref(false);
  const paletteOpen = ref(false);
  const sidebarTab = ref<SidebarTab>("branches");

  const layoutMode = computed<LayoutMode>(() => settings.values.layoutMode);
  const sidebarCollapsed = computed(() => settings.values.sidebarCollapsed);
  const paneSizes = computed<PaneSizes>(() => settings.values.paneSizes);

  /** Width of the detail panel: the pinned size after a drag, else the fraction of the window. */
  const detailWidth = computed(() => {
    const pinned = paneSizes.value.detail;
    if (pinned !== null) return clampPane("detail", pinned);
    return defaultDetailWidth(windowWidth.value, paneSizes.value.sidebar);
  });

  /** The review rail is hidden below the breakpoint unless the user asked for it. */
  const reviewRailCollapsed = computed(
    () =>
      layoutMode.value === "review" &&
      windowWidth.value < REVIEW_RAIL_BREAKPOINT &&
      !reviewRailShown.value,
  );

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

  function setWindowWidth(px: number): void {
    if (px >= REVIEW_RAIL_BREAKPOINT) reviewRailShown.value = false;
    windowWidth.value = px;
  }

  function showReviewRail(): void {
    reviewRailShown.value = true;
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

  function setSidebarTab(tab: SidebarTab): void {
    sidebarTab.value = tab;
  }

  /** Expands the sidebar on `tab` (the rail icons do this). */
  async function expandSidebar(tab: SidebarTab): Promise<void> {
    sidebarTab.value = tab;
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
    openPalette,
    closePalette,
    togglePalette,
  };
});
