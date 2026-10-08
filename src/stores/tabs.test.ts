import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import { fakeBackend } from "@/test/backend";
import { projectOf } from "@/test/entries";

import { useProjectsStore } from "./projects";
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

/** The row as the user reads it: each tab's kind, a comparison as "A ↔ B". */
const row = () =>
  useTabsStore().row.map((tab) =>
    tab.open?.kind === "compare" ? `${tab.open.a.label} ↔ ${tab.open.b.label}` : tab.kind,
  );
/** The tab shown, as `row` reads it. */
const shown = () => row()[useTabsStore().activeIndex];

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

  it("starts a project on its fixed tabs, the Overview only while it holds several repositories", async () => {
    fakeBackend({
      projects: [projectOf(1, "Geoportal", ["/api", "/web"]), projectOf(2, "Docs", ["/docs"])],
    });
    const { tabs, settings } = await start();
    await useProjectsStore().load();
    expect(row()).toEqual(["graph", "review", "changes", "overview"]);
    expect(shown()).toBe("graph");
    await settings.update("activeProject", 2);
    await nextTick();
    expect(row()).toEqual(["graph", "review", "changes"]);
    expect(tabs.row.every((tab) => tab.open === null)).toBe(true);
  });

  it("opens a new tab after the tab shown, or right after the fixed tabs while one shows", async () => {
    const { tabs, shell } = await start();
    tabs.openComparison(main, fix);
    expect(row()).toEqual(["graph", "review", "changes", "main ↔ claude/fix-auth"]);
    expect(shown()).toBe("main ↔ claude/fix-auth");
    tabs.openComparison(main, release);
    expect(row().slice(3)).toEqual(["main ↔ claude/fix-auth", "main ↔ release/2.4"]);
    // From a fixed tab: right after the fixed tabs, before the comparisons.
    await shell.setLayoutMode("review");
    await shell.setLayoutMode("settings");
    expect(row().slice(3)).toEqual(["settings", "main ↔ claude/fix-auth", "main ↔ release/2.4"]);
    expect(shell.layoutMode).toBe("settings");
    // Asking again for a view whose tab is open shows that tab; none is added.
    await shell.setLayoutMode("graph");
    await shell.setLayoutMode("settings");
    tabs.openComparison(main, fix);
    expect(row()).toHaveLength(6);
    expect(shown()).toBe("main ↔ claude/fix-auth");
    // The other direction is another comparison.
    tabs.openComparison(fix, main);
    expect(row()[5]).toBe("claude/fix-auth ↔ main");
  });

  it("goes round the row, and closing the tab shown shows the one before it", async () => {
    const { tabs, shell } = await start();
    tabs.openComparison(main, fix);
    await shell.setLayoutMode("graph");
    for (const expected of ["review", "changes", "main ↔ claude/fix-auth", "graph"]) {
      tabs.step(1);
      expect(shown()).toBe(expected);
    }
    tabs.step(-1);
    expect(shown()).toBe("main ↔ claude/fix-auth");
    expect(tabs.closeActive()).toBe(true);
    expect(shown()).toBe("changes");
    expect(row()).toEqual(["graph", "review", "changes"]);
    // A fixed tab never closes.
    expect(tabs.closeActive()).toBe(false);
    expect(row()).toHaveLength(3);
  });

  it("closes a tab not shown and keeps the one shown", async () => {
    const { tabs, shell } = await start();
    tabs.openComparison(main, fix);
    const first = tabs.activeKey as number;
    await shell.setLayoutMode("worktrees");
    tabs.close(first);
    expect(row()).toEqual(["graph", "review", "changes", "worktrees"]);
    expect(shell.layoutMode).toBe("worktrees");
  });

  it("shows the tab of a pair another tab compares already, the edited one closing", async () => {
    const { tabs } = await start();
    tabs.openComparison(main, fix);
    tabs.openComparison(main, release);
    tabs.setPair(main, fix);
    expect(row().slice(3)).toEqual(["main ↔ claude/fix-auth"]);
    expect(tabs.activePair).toEqual({ a: main, b: fix });
    // A pair no other tab compares changes the tab shown in place.
    tabs.openComparison(main, release);
    tabs.setPair(release, main);
    expect(row().slice(3)).toEqual(["main ↔ claude/fix-auth", "release/2.4 ↔ main"]);
  });

  it("shows the layout of the tab shown, Home's being the graph", async () => {
    const { tabs, shell, settings } = await start();
    tabs.openComparison(main, fix);
    expect(shell.layoutMode).toBe("compare");
    await shell.setLayoutMode("changes");
    expect(tabs.activePair).toBeNull();
    expect(shell.layoutMode).toBe("changes");
    await settings.update("activeProject", null);
    await nextTick();
    expect(row()).toEqual(["home"]);
    expect(shell.layoutMode).toBe("graph");
    // At Home the project's views show Home, and the settings open beside it.
    await shell.setLayoutMode("review");
    expect(shown()).toBe("home");
    await shell.setLayoutMode("settings");
    expect(row()).toEqual(["home", "settings"]);
    expect(tabs.closeActive()).toBe(true);
    expect(row()).toEqual(["home"]);
  });

  it("keeps each project's tabs, shows another project's Graph tab, and the launch the tab left", async () => {
    const { tabs, settings, shell } = await start();
    tabs.openComparison(main, fix);
    await shell.setLayoutMode("settings");
    await settings.update("activeProject", 2);
    await nextTick();
    expect(row()).toEqual(["graph", "review", "changes"]);
    tabs.openComparison(fix, release);
    await settings.update("activeProject", 1);
    await nextTick();
    // The settings opened from the comparison's tab went after it.
    expect(row().slice(3)).toEqual(["main ↔ claude/fix-auth", "settings"]);
    // Opening a project shows its Graph tab.
    expect(shown()).toBe("graph");
    await shell.setLayoutMode("review");
    await settings.flush();
    expect(settings.values.tabs).toEqual({
      "1": { open: [{ kind: "compare", a: main, b: fix }, { kind: "settings" }], active: "review" },
      "2": { open: [{ kind: "compare", a: fix, b: release }], active: 0 },
    });
    // A launch shows the tab the window was closed on.
    const again = await start({ tabs: settings.values.tabs });
    expect(again.shell.layoutMode).toBe("review");
    const other = await start({ tabs: settings.values.tabs, activeProject: 2 });
    expect(other.tabs.activePair).toEqual({ a: fix, b: release });
  });

  it("keeps no tab without a project, and drops the tabs of projects that are gone", async () => {
    const { tabs, settings } = await start({
      tabs: {
        "1": { open: [{ kind: "compare", a: main, b: fix }], active: "graph" },
        "7": { open: [{ kind: "worktrees" }], active: 0 },
      },
    });
    tabs.prune([1]);
    expect(Object.keys(settings.values.tabs)).toEqual(["1"]);
    await settings.update("activeProject", null);
    await nextTick();
    expect(row()).toEqual(["home"]);
    await useShellStore().setLayoutMode("settings");
    await settings.flush();
    expect(Object.keys(settings.values.tabs)).toEqual(["1"]);
  });

  it("opens an earlier version's comparisons as tabs and its project's tab as the tab of its layout", async () => {
    const earlier = {
      layoutMode: "worktrees",
      tabs: {
        "1": { comparisons: [{ a: main, b: fix }], active: 0 },
        "2": { comparisons: [{ a: main, b: release }], active: 1 },
      },
    };
    const { settings, shell } = await start(earlier);
    expect(row().slice(3)).toEqual(["main ↔ claude/fix-auth", "worktrees"]);
    expect(shell.layoutMode).toBe("worktrees");
    // The layout belonged to the open project's tab alone.
    await settings.update("activeProject", 2);
    await nextTick();
    expect(row().slice(3)).toEqual(["main ↔ release/2.4"]);
    expect(shell.layoutMode).toBe("graph");
    // The other project's comparison was shown: the launch shows it there.
    const other = await start({ ...earlier, activeProject: 2 });
    expect(other.shell.layoutMode).toBe("compare");
  });
});
