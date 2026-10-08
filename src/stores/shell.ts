// Shell layout state: the layout shown (the tab shown's), the sidebar (where the tab shown has
// one, its section and whether its docked panel is open), pane sizes (persisted through the
// settings store), the narrow-window collapse of the review rail and of the detail panel under
// the zoom, and the palette.

import { defineStore } from "pinia";
import { computed, ref } from "vue";

import { useProjectsStore } from "./projects";
import { useRepoStore } from "./repo";
import {
  defaultColumnWidths,
  defaultSettings,
  useSettingsStore,
  type ColumnWidths,
  type LayoutMode,
  type PaneSizes,
  type ProjectLayout,
  type SidebarSectionId,
  type SidebarView,
} from "./settings";
import { useTabsStore } from "./tabs";

export { sidebarSectionIds, type SidebarSectionId } from "./settings";

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
/** The sidebar's rail (`--rail-w`), beside which its panel docks while open. */
const RAIL_WIDTH = 48;
/** The room the detail panel's default share leaves the sidebar. */
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
  /** Under the narrow breakpoint the panel starts closed; opened there, it stays open until the
   * page crosses the breakpoint. Session state. */
  const narrowSidebarOpen = ref(false);
  /** Set when the panel opens or shows another section: the panel takes it (`takeSidebarFocus`)
   * and focuses its list. */
  const sidebarFocusPending = ref(false);
  /** The panel's list keeps the focus across a reload of its rows (a worktree opened as the
   * context lists the worktrees again): the layout does not take it meanwhile. */
  const sidebarFocusHeld = ref(false);
  /** Each section's filter, kept while another shows or the panel is closed; cleared when
   * another repository shows. */
  const sidebarFilters = ref<Record<SidebarSectionId, string>>(noFilters());

  /** The layout shown: the tab shown's, Home's being graph focus with no project. */
  const layoutMode = computed<LayoutMode>(() =>
    tabs.activeKind === "home" ? "graph" : tabs.activeKind,
  );
  const narrow = computed(() => windowWidth.value < NARROW_BREAKPOINT);
  const paneSizes = computed<PaneSizes>(() => settings.values.paneSizes);
  const columnWidths = computed<ColumnWidths>(() => settings.values.columnWidths);

  /**
   * The kind of tab whose sidebar shows, null where none does: the views that act on the
   * repository the project shows have one; the Overview, the Changes of a project of several
   * repositories, the settings and Home have none. The projects and the repository are read
   * when this is, since those stores need this one to be set up.
   */
  const sidebarView = computed<SidebarView | null>(() => {
    const projects = useProjectsStore();
    if (useRepoStore().state.kind === "empty" && projects.active === null) return null;
    const mode = layoutMode.value;
    if (mode === "overview" || mode === "settings") return null;
    if (mode === "changes" && projects.multi) return null;
    return mode;
  });

  /** Whether the sidebar's panel is open in the tab shown. */
  const sidebarOpen = computed(() => {
    const view = sidebarView.value;
    if (view === null) return false;
    return narrow.value ? narrowSidebarOpen.value : settings.values.sidebarPanels[view];
  });

  /** The section the panel shows; Branches in a project of one, which has no Repositories. */
  const sidebarSection = computed<SidebarSectionId>(() => {
    const section = settings.values.sidebarSection;
    if (section === "repos" && useProjectsStore().activeMembers.length <= 1) return "local";
    return section;
  });

  /** The room the sidebar takes: its rail, and its panel while open; none where it is not. */
  const sidebarWidth = computed(() => {
    if (sidebarView.value === null) return 0;
    return RAIL_WIDTH + (sidebarOpen.value ? paneSizes.value.sidebar : 0);
  });

  /**
   * The detail panel's limits, for its divider as for its width: 360 to 900, and
   * under the narrow breakpoint 280 up to what leaves the graph panel 320px beside the sidebar.
   */
  const detailLimits = computed(() => {
    if (!narrow.value) return paneLimits.detail;
    const room = windowWidth.value - Math.max(sidebarWidth.value, RAIL_WIDTH) - NARROW_GRAPH_MIN;
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

  /** Shows the tab of `mode`, opening the dashboard's or the settings' tab when missing; the
   * other tabs stay. */
  function setLayoutMode(mode: ProjectLayout): Promise<void> {
    tabs.show(mode);
    return Promise.resolve();
  }

  /** Opens or closes the panel in the tab shown: remembered per kind of tab, and for the
   * session alone under the narrow breakpoint. */
  function setSidebarOpen(open: boolean): void {
    const view = sidebarView.value;
    if (view === null || open === sidebarOpen.value) return;
    if (narrow.value) narrowSidebarOpen.value = open;
    else void settings.update("sidebarPanels", { ...settings.values.sidebarPanels, [view]: open });
    if (open) sidebarFocusPending.value = true;
  }

  /** Holds the focus for the panel's list while its rows are read again, or lets it go. */
  function holdSidebarFocus(held: boolean): void {
    sidebarFocusHeld.value = held;
  }

  /** Whether the panel should focus its list now; true once per opening or section shown. */
  function takeSidebarFocus(): boolean {
    const pending = sidebarFocusPending.value;
    sidebarFocusPending.value = false;
    return pending;
  }

  /** ⌘B and the palette: closes the open panel, or opens it on the section it showed last. */
  function toggleSidebar(): void {
    setSidebarOpen(!sidebarOpen.value);
  }

  /** A rail icon: closes the panel when it shows `id`, else shows `id` in it, opening it. */
  function pickSidebarSection(id: SidebarSectionId): void {
    if (sidebarOpen.value && sidebarSection.value === id) {
      setSidebarOpen(false);
      return;
    }
    if (settings.values.sidebarSection !== id) void settings.update("sidebarSection", id);
    if (sidebarOpen.value) sidebarFocusPending.value = true;
    else setSidebarOpen(true);
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

  /** Crossing a breakpoint in either direction hands its rail back to the automatic rule, and
   * the sidebar's panel to what each kind of tab remembers (closed under the narrow one). */
  function setWindowWidth(px: number): void {
    const railNarrow = px < REVIEW_RAIL_BREAKPOINT;
    if (railNarrow !== windowWidth.value < REVIEW_RAIL_BREAKPOINT) {
      reviewRailPreference.value = "auto";
    }
    if (px < NARROW_BREAKPOINT !== windowWidth.value < NARROW_BREAKPOINT) {
      narrowSidebarOpen.value = false;
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
    sidebarView,
    sidebarOpen,
    sidebarSection,
    sidebarWidth,
    takeSidebarFocus,
    sidebarFocusHeld,
    holdSidebarFocus,
    sidebarFilters,
    setSidebarOpen,
    toggleSidebar,
    pickSidebarSection,
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
