import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import { memoryStorage, useSettingsStore, type CompareEndpoint } from "./settings";
import { useShellStore } from "./shell";
import { useTabsStore } from "./tabs";

const endpoint = (label: string): CompareEndpoint => ({
  kind: "revision",
  rev: `refs/heads/${label}`,
  label,
});
const main = endpoint("main");
const fix = endpoint("claude/fix-auth");
const release = endpoint("release/2.4");

const names = () => useTabsStore().comparisons.map((tab) => `${tab.a.label} ↔ ${tab.b.label}`);

async function start(stored: Record<string, unknown> = {}) {
  setActivePinia(createPinia());
  const settings = useSettingsStore();
  await settings.init(memoryStorage({ activeProject: 1, ...stored }), "windows");
  return { settings, tabs: useTabsStore(), shell: useShellStore() };
}

describe("tabs store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("opens each comparison in a tab after the one shown, and shows an open pair's own tab", async () => {
    const { tabs } = await start();
    expect(tabs.comparisons).toEqual([]);
    tabs.openComparison(main, fix);
    expect(names()).toEqual(["main ↔ claude/fix-auth"]);
    expect(tabs.activeIndex).toBe(1);
    tabs.showProject();
    tabs.openComparison(main, release);
    // After the project's tab: first in the row of comparisons.
    expect(names()).toEqual(["main ↔ release/2.4", "main ↔ claude/fix-auth"]);
    expect(tabs.activeIndex).toBe(1);
    tabs.openComparison(main, fix);
    expect(names()).toHaveLength(2);
    expect(tabs.activePair).toEqual({ a: main, b: fix });
    // The other direction is another comparison.
    tabs.openComparison(fix, main);
    expect(names()).toEqual([
      "main ↔ release/2.4",
      "main ↔ claude/fix-auth",
      "claude/fix-auth ↔ main",
    ]);
  });

  it("goes round the row, and closing the tab shown shows the one before it", async () => {
    const { tabs } = await start();
    tabs.openComparison(main, fix);
    tabs.openComparison(main, release);
    tabs.showProject();
    tabs.step(1);
    expect(tabs.activePair?.b).toEqual(fix);
    tabs.step(1);
    expect(tabs.activePair?.b).toEqual(release);
    tabs.step(1);
    expect(tabs.activePair).toBeNull();
    tabs.step(-1);
    expect(tabs.activePair?.b).toEqual(release);
    expect(tabs.closeActive()).toBe(true);
    expect(tabs.activePair?.b).toEqual(fix);
    expect(tabs.closeActive()).toBe(true);
    expect(tabs.activePair).toBeNull();
    expect(tabs.comparisons).toEqual([]);
    // The project's tab never closes.
    expect(tabs.closeActive()).toBe(false);
  });

  it("closes a tab not shown and keeps the one shown", async () => {
    const { tabs } = await start();
    tabs.openComparison(main, fix);
    const first = tabs.activeId!;
    tabs.openComparison(main, release);
    tabs.close(first);
    expect(names()).toEqual(["main ↔ release/2.4"]);
    expect(tabs.activePair?.b).toEqual(release);
  });

  it("shows the tab of a pair another tab compares already, the edited one closing", async () => {
    const { tabs } = await start();
    tabs.openComparison(main, fix);
    tabs.openComparison(main, release);
    tabs.setPair(main, fix);
    expect(names()).toEqual(["main ↔ claude/fix-auth"]);
    expect(tabs.activePair).toEqual({ a: main, b: fix });
  });

  it("changes the pair of the tab shown in place", async () => {
    const { tabs } = await start();
    tabs.openComparison(main, fix);
    tabs.openComparison(main, release);
    tabs.setPair(release, main);
    expect(names()).toEqual(["main ↔ claude/fix-auth", "release/2.4 ↔ main"]);
  });

  it("shows the layout of the tab shown: the comparison, else the project's", async () => {
    const { tabs, shell, settings } = await start();
    await shell.setLayoutMode("review");
    tabs.openComparison(main, fix);
    expect(shell.layoutMode).toBe("compare");
    // A toggle or ⌘1 to ⌘4 shows the project's tab with that layout.
    await shell.setLayoutMode("changes");
    expect(tabs.activePair).toBeNull();
    expect(shell.layoutMode).toBe("changes");
    expect(settings.values.layoutMode).toBe("changes");
    expect(names()).toEqual(["main ↔ claude/fix-auth"]);
  });

  it("keeps each project's comparisons, shows another project's own tab, and the launch the tab left", async () => {
    const { tabs, settings } = await start();
    tabs.openComparison(main, fix);
    tabs.openComparison(main, release);
    await settings.update("activeProject", 2);
    expect(tabs.comparisons).toEqual([]);
    tabs.openComparison(fix, release);
    await settings.update("activeProject", 1);
    expect(names()).toEqual(["main ↔ claude/fix-auth", "main ↔ release/2.4"]);
    // Opening a project shows its own tab.
    expect(tabs.activePair).toBeNull();
    tabs.showIndex(2);
    await settings.flush();
    expect(settings.values.tabs).toEqual({
      "1": {
        comparisons: [
          { a: main, b: fix },
          { a: main, b: release },
        ],
        active: 2,
      },
      "2": { comparisons: [{ a: fix, b: release }], active: 1 },
    });
    // A launch shows the tab the window was closed on.
    const again = await start({ tabs: settings.values.tabs });
    expect(again.tabs.activePair).toEqual({ a: main, b: release });
    expect(again.shell.layoutMode).toBe("compare");
  });

  it("keeps no comparison without a project, and drops the tabs of projects that are gone", async () => {
    const { tabs, settings } = await start({
      tabs: {
        "1": { comparisons: [{ a: main, b: fix }], active: 0 },
        "7": { comparisons: [{ a: main, b: release }], active: 1 },
      },
    });
    tabs.prune([1]);
    expect(Object.keys(settings.values.tabs)).toEqual(["1"]);
    await settings.update("activeProject", null);
    expect(tabs.comparisons).toEqual([]);
    tabs.openComparison(main, fix);
    expect(Object.keys(settings.values.tabs)).toEqual(["1"]);
  });
});
