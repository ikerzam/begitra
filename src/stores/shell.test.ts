import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import { fakeBackend } from "@/test/backend";
import { projectOf } from "@/test/entries";

import { useProjectsStore } from "./projects";
import { useRepoStore } from "./repo";
import { memoryStorage, useSettingsStore } from "./settings";
import { clampPane, defaultDetailWidth, useShellStore } from "./shell";

/** A repository opening: the sidebar shows wherever the tab shown has one. */
function opening(): void {
  useRepoStore().state = { kind: "opening", path: "/r" };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("shell store", () => {
  it("switches layouts through the tabs, never through the settings", async () => {
    const settings = useSettingsStore();
    const storage = memoryStorage({ activeProject: 1 });
    await settings.init(storage, "windows");
    const shell = useShellStore();
    expect(shell.layoutMode).toBe("graph");
    await shell.setLayoutMode("review");
    expect(shell.layoutMode).toBe("review");
    expect(storage.data.has("layoutMode")).toBe(false);
  });

  it("opens and closes the sidebar's panel per kind of tab, remembered", async () => {
    const settings = useSettingsStore();
    const storage = memoryStorage({ activeProject: 1 });
    await settings.init(storage, "windows");
    opening();
    const shell = useShellStore();
    // Open in graph focus by default, on Branches; Ctrl B closes it there alone.
    expect(shell.sidebarView).toBe("graph");
    expect(shell.sidebarOpen).toBe(true);
    expect(shell.sidebarSection).toBe("local");
    expect(shell.sidebarWidth).toBe(288);
    shell.toggleSidebar();
    expect(shell.sidebarOpen).toBe(false);
    expect(shell.sidebarWidth).toBe(48);
    // Closed in review focus by default; a rail icon opens it on its section, to be focused.
    await shell.setLayoutMode("review");
    expect(shell.sidebarOpen).toBe(false);
    shell.pickSidebarSection("tags");
    expect(shell.sidebarOpen).toBe(true);
    expect(shell.sidebarSection).toBe("tags");
    expect(shell.takeSidebarFocus()).toBe(true);
    expect(shell.takeSidebarFocus()).toBe(false);
    // Another icon shows its section; the shown section's icon closes the panel.
    shell.pickSidebarSection("worktrees");
    expect(shell.sidebarSection).toBe("worktrees");
    expect(shell.takeSidebarFocus()).toBe(true);
    shell.pickSidebarSection("worktrees");
    expect(shell.sidebarOpen).toBe(false);
    shell.pickSidebarSection("worktrees");
    // Each kind of tab keeps its own: graph focus's is still closed.
    await shell.setLayoutMode("graph");
    expect(shell.sidebarOpen).toBe(false);
    await settings.flush();
    expect(storage.data.get("sidebarPanels")).toEqual({
      graph: false,
      review: true,
      compare: true,
      worktrees: true,
      changes: true,
    });
    expect(storage.data.get("sidebarSection")).toBe("worktrees");
  });

  it("shows no sidebar in the Overview, the settings, a project's folder view or Home", async () => {
    fakeBackend({
      projects: [projectOf(1, "Geoportal", ["/api", "/web"]), projectOf(2, "Docs", ["/docs"])],
    });
    const settings = useSettingsStore();
    await settings.init(memoryStorage(), "windows");
    const shell = useShellStore();
    await useProjectsStore().load();
    // Home: no project, no repository.
    expect(shell.sidebarView).toBeNull();
    shell.toggleSidebar();
    expect(shell.sidebarOpen).toBe(false);
    expect(shell.sidebarWidth).toBe(0);
    await settings.update("activeProject", 1);
    await nextTick();
    opening();
    expect(shell.sidebarView).toBe("graph");
    for (const mode of ["settings", "overview", "changes"] as const) {
      await shell.setLayoutMode(mode);
      expect(shell.sidebarView).toBeNull();
    }
    // A project of one shows the sidebar beside its changes, and Branches in place of its
    // Repositories.
    await settings.update("sidebarSection", "repos");
    expect(shell.sidebarSection).toBe("repos");
    await settings.update("activeProject", 2);
    await nextTick();
    await shell.setLayoutMode("changes");
    expect(shell.sidebarView).toBe("changes");
    expect(shell.sidebarSection).toBe("local");
  });

  it("keeps a filter per panel until the filters are cleared", async () => {
    const settings = useSettingsStore();
    await settings.init(memoryStorage(), "windows");
    const shell = useShellStore();
    shell.setSidebarFilter("local", "auth");
    shell.setSidebarFilter("tags", "v2");
    expect(shell.sidebarFilters.local).toBe("auth");
    expect(shell.sidebarFilters.remote).toBe("");
    expect(shell.sidebarFilters.tags).toBe("v2");
    shell.clearSidebarFilters();
    expect(Object.values(shell.sidebarFilters)).toEqual(["", "", "", "", ""]);
  });

  it("remembers pane sizes within limits", async () => {
    const settings = useSettingsStore();
    const storage = memoryStorage();
    await settings.init(storage, "linux");
    const shell = useShellStore();
    await shell.setPaneSize("detail", 520);
    expect(shell.paneSizes.detail).toBe(520);
    await shell.setPaneSize("detail", 100);
    expect(shell.paneSizes.detail).toBe(360);
    expect(clampPane("sidebar", 9999)).toBe(420);
    expect((storage.data.get("paneSizes") as { detail: number }).detail).toBe(360);
  });

  it("puts a pane back to its default, the detail panel back to its share of the window", async () => {
    const settings = useSettingsStore();
    await settings.init(memoryStorage(), "windows");
    const shell = useShellStore();
    shell.setWindowWidth(1440);
    await shell.setPaneSize("detail", 520);
    await shell.setPaneSize("sidebar", 320);
    await shell.setPaneSize("files", 700);
    expect(shell.paneSizes.files).toBe(560);
    await shell.resetPaneSize("detail");
    await shell.resetPaneSize("sidebar");
    expect(shell.paneSizes.detail).toBeNull();
    expect(shell.paneSizes.sidebar).toBe(240);
    expect(shell.detailWidth).toBe(480);
  });

  it("keeps table columns between 60 and 480px and back to their default widths", async () => {
    const settings = useSettingsStore();
    const storage = memoryStorage();
    await settings.init(storage, "windows");
    const shell = useShellStore();
    expect(shell.columnWidths.worktrees).toEqual({ path: 200, branch: 200, state: 96, ahead: 84 });
    await shell.setColumnWidth("worktrees", "state", 120.4);
    await shell.setColumnWidth("worktrees", "path", 20);
    await shell.setColumnWidth("worktrees", "branch", 999);
    expect(shell.columnWidths.worktrees.state).toBe(120);
    expect(shell.columnWidths.worktrees.path).toBe(60);
    expect(shell.columnWidths.worktrees.branch).toBe(480);
    expect(storage.data.get("columnWidths")).toEqual(shell.columnWidths);
    await shell.resetColumnWidth("worktrees", "state");
    expect(shell.columnWidths.worktrees.state).toBe(96);
  });

  it("sizes the detail panel as 40% of the window minus the sidebar until it is dragged", async () => {
    const settings = useSettingsStore();
    const storage = memoryStorage();
    await settings.init(storage, "windows");
    const shell = useShellStore();
    shell.setWindowWidth(1440);
    expect(shell.detailWidth).toBe(480);
    shell.setWindowWidth(1280);
    expect(shell.detailWidth).toBe(416);
    shell.setWindowWidth(1024);
    expect(shell.detailWidth).toBe(360);
    expect(defaultDetailWidth(1440, 240)).toBe(480);
    await shell.setPaneSize("detail", 520);
    shell.setWindowWidth(1440);
    expect(shell.detailWidth).toBe(520);
    expect((storage.data.get("paneSizes") as { detail: number }).detail).toBe(520);
  });

  it("gives the graph panel 320px under 1024px, the detail panel down to 280px", async () => {
    const settings = useSettingsStore();
    await settings.init(memoryStorage(), "windows");
    const shell = useShellStore();
    // 40% of the page less the rail: 823 - 48 = 775.
    shell.setWindowWidth(823);
    expect(shell.detailWidth).toBe(310);
    // 1280px at 200%: its share (237) is under the floor.
    shell.setWindowWidth(640);
    expect(shell.detailWidth).toBe(280);
    // A width dragged at normal widths leaves the graph panel 320px: 823 - 48 - 320.
    shell.setWindowWidth(1440);
    await shell.setPaneSize("detail", 520);
    shell.setWindowWidth(823);
    expect(shell.detailWidth).toBe(455);
    shell.setWindowWidth(1440);
    expect(shell.detailWidth).toBe(520);
    // The panel starts closed there; opened, its room comes off the detail panel's limits:
    // 823 - 288 - 320 is under the floor.
    await shell.resetPaneSize("detail");
    shell.setWindowWidth(823);
    opening();
    expect(shell.sidebarOpen).toBe(false);
    shell.toggleSidebar();
    expect(shell.sidebarOpen).toBe(true);
    expect(shell.detailLimits).toEqual({ min: 280, max: 280 });
    expect(shell.detailWidth).toBe(280);
    // Crossing the breakpoint brings back what graph focus remembers, open, and closes it again
    // on the way down.
    shell.setWindowWidth(1440);
    expect(shell.sidebarOpen).toBe(true);
    shell.setWindowWidth(823);
    expect(shell.sidebarOpen).toBe(false);
    // 1024px and above keep the normal limits, 360 to 900.
    shell.setWindowWidth(1024);
    expect(shell.detailWidth).toBe(360);
    expect(shell.detailLimits).toEqual({ min: 360, max: 900 });
  });

  it("lets the detail's divider work within the narrow limits while zoomed", async () => {
    const settings = useSettingsStore();
    await settings.init(memoryStorage(), "windows");
    const shell = useShellStore();
    shell.setWindowWidth(823);
    expect(shell.detailLimits).toEqual({ min: 280, max: 455 });
    await shell.setPaneSize("detail", 300);
    expect(shell.detailWidth).toBe(300);
    await shell.setPaneSize("detail", 200);
    expect(shell.detailWidth).toBe(280);
    await shell.setPaneSize("detail", 999);
    expect(shell.detailWidth).toBe(455);
    // A width pinned while zoomed shows within the 360 to 900 limits at normal widths.
    await shell.setPaneSize("detail", 300);
    shell.setWindowWidth(1440);
    expect(shell.detailWidth).toBe(360);
  });

  it("collapses the review rail below 1100px until the user shows it", async () => {
    const settings = useSettingsStore();
    await settings.init(memoryStorage({ activeProject: 1 }), "macos");
    const shell = useShellStore();
    await shell.setLayoutMode("review");
    shell.setWindowWidth(1440);
    expect(shell.reviewRailCollapsed).toBe(false);
    shell.setWindowWidth(1024);
    expect(shell.reviewRailCollapsed).toBe(true);
    shell.showReviewRail();
    expect(shell.reviewRailCollapsed).toBe(false);
    shell.setWindowWidth(1440);
    shell.setWindowWidth(1000);
    expect(shell.reviewRailCollapsed).toBe(true);
    await shell.setLayoutMode("graph");
    expect(shell.reviewRailCollapsed).toBe(false);
  });

  it("hides and shows the review rail on request at any width", async () => {
    const settings = useSettingsStore();
    await settings.init(memoryStorage({ activeProject: 1 }), "windows");
    const shell = useShellStore();
    await shell.setLayoutMode("review");
    shell.setWindowWidth(1440);
    expect(shell.reviewRailCollapsed).toBe(false);
    shell.hideReviewRail();
    expect(shell.reviewRailCollapsed).toBe(true);
    shell.setWindowWidth(1300);
    expect(shell.reviewRailCollapsed).toBe(true);
    shell.showReviewRail();
    expect(shell.reviewRailCollapsed).toBe(false);
    shell.setWindowWidth(1000);
    expect(shell.reviewRailCollapsed).toBe(true);
    shell.showReviewRail();
    expect(shell.reviewRailCollapsed).toBe(false);
    shell.hideReviewRail();
    expect(shell.reviewRailCollapsed).toBe(true);
    shell.setWindowWidth(1440);
    expect(shell.reviewRailCollapsed).toBe(false);
  });

  it("opens and closes the palette", () => {
    const shell = useShellStore();
    expect(shell.paletteOpen).toBe(false);
    shell.togglePalette();
    expect(shell.paletteOpen).toBe(true);
    shell.closePalette();
    expect(shell.paletteOpen).toBe(false);
    shell.openPalette();
    expect(shell.paletteOpen).toBe(true);
  });
});
