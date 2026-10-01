import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import { memoryStorage, useSettingsStore } from "./settings";
import { clampPane, defaultDetailWidth, useShellStore } from "./shell";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("shell store", () => {
  it("switches layout modes and toggles the sidebar through the settings", async () => {
    const settings = useSettingsStore();
    const storage = memoryStorage();
    await settings.init(storage, "windows");
    const shell = useShellStore();
    expect(shell.layoutMode).toBe("graph");
    await shell.setLayoutMode("review");
    expect(shell.layoutMode).toBe("review");
    expect(storage.data.get("layoutMode")).toBe("review");
    await shell.toggleSidebar();
    expect(shell.sidebarCollapsed).toBe(true);
    await shell.toggleSidebar();
    expect(shell.sidebarCollapsed).toBe(false);
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

  it("shows the sidebar as its rail under 1024px until the user shows it, for the session", async () => {
    const settings = useSettingsStore();
    await settings.init(memoryStorage(), "windows");
    const shell = useShellStore();
    shell.setWindowWidth(1440);
    expect(shell.sidebarCollapsed).toBe(false);
    // 1440px at 175% zoom.
    shell.setWindowWidth(823);
    expect(shell.sidebarCollapsed).toBe(true);
    await shell.expandSidebar("local");
    expect(shell.sidebarCollapsed).toBe(false);
    expect(shell.sidebarReveal?.id).toBe("local");
    await shell.toggleSidebar();
    expect(shell.sidebarCollapsed).toBe(true);
    await shell.toggleSidebar();
    expect(shell.sidebarCollapsed).toBe(false);
    // The remembered setting is left as it was.
    expect(settings.values.sidebarCollapsed).toBe(false);
    // Crossing 1024px hands the sidebar back to the rule.
    shell.setWindowWidth(1440);
    expect(shell.sidebarCollapsed).toBe(false);
    shell.setWindowWidth(823);
    expect(shell.sidebarCollapsed).toBe(true);
    // A sidebar collapsed at normal widths stays collapsed there.
    await shell.expandSidebar("repos");
    shell.setWindowWidth(1440);
    await shell.toggleSidebar();
    shell.setWindowWidth(823);
    shell.setWindowWidth(1440);
    expect(shell.sidebarCollapsed).toBe(true);
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
    // With the sidebar shown while narrow the room is the page less the sidebar.
    await shell.resetPaneSize("detail");
    shell.setWindowWidth(823);
    await shell.expandSidebar("repos");
    expect(shell.detailWidth).toBe(280);
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
    await settings.init(memoryStorage(), "macos");
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
    await settings.init(memoryStorage(), "windows");
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
