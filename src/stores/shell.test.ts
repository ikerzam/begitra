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
    expect(shell.columnWidths.home).toEqual({ name: 200, branch: 180, ahead: 84, commit: 80 });
    await shell.setColumnWidth("home", "name", 260.4);
    await shell.setColumnWidth("worktrees", "path", 20);
    await shell.setColumnWidth("worktrees", "branch", 999);
    expect(shell.columnWidths.home.name).toBe(260);
    expect(shell.columnWidths.worktrees.path).toBe(60);
    expect(shell.columnWidths.worktrees.branch).toBe(480);
    expect(storage.data.get("columnWidths")).toEqual(shell.columnWidths);
    await shell.resetColumnWidth("home", "name");
    expect(shell.columnWidths.home.name).toBe(200);
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
