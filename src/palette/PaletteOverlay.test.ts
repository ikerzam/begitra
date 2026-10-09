import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { useBranchesStore } from "@/stores/branches";
import { useLocalChangesStore } from "@/stores/localChanges";
import { useIndexStore } from "@/stores/index";
import { useRecentBranchesStore } from "@/stores/recentBranches";
import { useProjectsStore } from "@/stores/projects";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { fakeBackend, writeGate } from "@/test/backend";
import { entryOf, projectOf } from "@/test/entries";
import { mountWithI18n } from "@/test/mount";

import PaletteOverlay from "./PaletteOverlay.vue";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(() => Promise.resolve(null)) }));

beforeEach(async () => {
  setActivePinia(createPinia());
  setShortcutRegistry(new ShortcutRegistry("windows"));
  mockIPC(() => null);
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  clearMocks();
  setShortcutRegistry(undefined);
});

describe("PaletteOverlay", () => {
  it("lists every project's repositories under Repos, the open project's first, and shows the chosen one", async () => {
    clearMocks();
    const geo = entryOf("/code/geoportal");
    const infra = entryOf("/code/geoportal-infra");
    const begitra = entryOf("/code/begitra");
    const calls = fakeBackend({
      repositories: [geo, infra, begitra],
      projects: [
        projectOf(1, "Geoportal", [geo.path, infra.path], { openedAt: 10 }),
        projectOf(2, "Tools", [begitra.path], { openedAt: 5 }),
      ],
      rootIsPath: true,
    });
    const [index, projects, shell] = [useIndexStore(), useProjectsStore(), useShellStore()];
    await Promise.all([index.load(), projects.load()]);
    await projects.open(2);
    await flushPromises();
    shell.openPalette();
    const wrapper = mountWithI18n(PaletteOverlay, { attachTo: document.body });
    // With an empty query: the recent projects, and the open project's repositories.
    const list = wrapper.get('[data-testid="palette-list"]');
    expect(list.text()).toContain("Projects");
    expect(list.text()).toContain("Repos");
    const repoRows = () =>
      wrapper
        .findAll('[data-testid="palette-row"]')
        .filter((row) => row.attributes("id") !== undefined)
        .map((row) => row.text())
        .filter((text) => text.endsWith("Tools") || text.endsWith("Geoportal"));
    expect(repoRows()).toEqual(["begitraTools"]);
    const input = wrapper.get('[data-testid="palette-input"]');
    await input.setValue("infra");
    expect(wrapper.findAll('[data-testid="palette-row"]').map((r) => r.text())).toEqual([
      "geoportal-infraGeoportal",
    ]);
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(shell.paletteOpen).toBe(false);
    // The repository of another project opens that project, showing it.
    expect(projects.active?.name).toBe("Geoportal");
    expect(calls.map((call) => call.cmd)).toContain("open_repository");
    expect(useRepoStore().repo?.root).toBe(infra.path);
    expect(useSettingsStore().values.paletteRecents).toEqual([]);
    wrapper.unmount();
  });

  /** Opens `/r` on `options`, runs "Checkout previous branch" from the palette, answers the calls. */
  async function checkoutPrevious(options: Parameters<typeof fakeBackend>[0]) {
    clearMocks();
    const calls = fakeBackend(options);
    await useRepoStore().open("/r");
    await flushPromises();
    useShellStore().openPalette();
    const wrapper = mountWithI18n(PaletteOverlay, { attachTo: document.body });
    await flushPromises();
    const input = wrapper.get('[data-testid="palette-input"]');
    await input.setValue("checkout previous");
    expect(wrapper.findAll('[data-testid="palette-row"]')[0]?.text()).toBe(
      "Checkout previous branch",
    );
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    wrapper.unmount();
    return calls.filter((call) => call.cmd === "switch").map((call) => call.args["target"]);
  }

  it("checks out the previous branch as the picker does, local changes in the way", async () => {
    const switches = await checkoutPrevious({ recentBranches: ["develop"], dirtySwitch: true });
    expect(switches).toEqual([{ kind: "branch", name: "develop" }]);
    expect(useLocalChangesStore().prompt).toMatchObject({
      operation: "switch",
      target: "develop",
    });
  });

  it("opens the held-by-a-worktree dialog when git says another worktree has the branch", async () => {
    const switches = await checkoutPrevious({
      recentBranches: ["develop"],
      writeErrors: {
        "/r": {
          code: "git.cli_failed",
          message: "git switch failed",
          detail: "fatal: 'develop' is already used by worktree at 'C:/wt/dev'",
        },
      },
    });
    expect(switches).toEqual([{ kind: "branch", name: "develop" }]);
    expect(useBranchesStore().prompt).toEqual({
      kind: "heldElsewhere",
      branch: "develop",
      path: "C:/wt/dev",
    });
  });

  it("offers no previous branch right after a switch, until the list is read again", async () => {
    clearMocks();
    const gate = writeGate();
    fakeBackend({ recentBranches: ["develop"], recentGate: gate });
    const recent = useRecentBranchesStore();
    await useRepoStore().open("/r");
    await flushPromises();
    gate.release();
    await flushPromises();
    const offered = () => {
      useShellStore().openPalette();
      const wrapper = mountWithI18n(PaletteOverlay, { attachTo: document.body });
      return wrapper;
    };
    const run = offered();
    await run.get('[data-testid="palette-input"]').setValue("checkout previous");
    await run.get('[data-testid="palette-input"]').trigger("keydown", { key: "Enter" });
    await flushPromises();
    run.unmount();
    // The switch went through: the list from before names the branch just entered.
    expect(recent.previous).toBeNull();
    expect(gate.waiting).toEqual(["recent_branches"]);
    const again = offered();
    await again.get('[data-testid="palette-input"]').setValue("checkout previous");
    expect(again.findAll('[data-testid="palette-row"]').map((r) => r.text())).not.toContain(
      "Checkout previous branch",
    );
    again.unmount();
    gate.release();
    await flushPromises();
    expect(recent.previous).toBe("develop");
  });

  it("lists the commands with their hints, filters, runs with enter and closes", async () => {
    const shell = useShellStore();
    // A repository opening: review focus has a tab to show, which Home has not.
    useRepoStore().state = { kind: "opening", path: "/r" };
    shell.openPalette();
    const wrapper = mountWithI18n(PaletteOverlay, { attachTo: document.body });
    const rows = wrapper.findAll('[data-testid="palette-row"]');
    expect(rows.map((r) => r.text())).toContain("Switch to review focusCtrl 2");
    expect(rows.some((r) => r.text().includes("Open in terminal"))).toBe(false);

    const input = wrapper.get('[data-testid="palette-input"]');
    await input.setValue("review focus");
    expect(wrapper.findAll('[data-testid="palette-row"]')).toHaveLength(1);
    await input.trigger("keydown", { key: "Enter" });
    expect(shell.layoutMode).toBe("review");
    expect(shell.paletteOpen).toBe(false);
    wrapper.unmount();
  });

  it("keeps the recents across close and open through the settings", async () => {
    const shell = useShellStore();
    shell.openPalette();
    let wrapper = mountWithI18n(PaletteOverlay, { attachTo: document.body });
    await wrapper.get('[data-testid="palette-input"]').setValue("rev");
    await wrapper.get('[data-testid="palette-input"]').trigger("keydown", { key: "Enter" });
    expect(shell.paletteOpen).toBe(false);
    wrapper.unmount();
    expect(useSettingsStore().values.paletteRecents).toEqual(["review-focus"]);

    shell.openPalette();
    wrapper = mountWithI18n(PaletteOverlay, { attachTo: document.body });
    const list = wrapper.get('[data-testid="palette-list"]');
    expect(list.text().startsWith("Recent")).toBe(true);
    expect(wrapper.findAll('[data-testid="palette-row"]')[0]?.text()).toContain(
      "Switch to review focus",
    );
    wrapper.unmount();
  });

  it("names the active row for assistive technology and keeps Tab inside", async () => {
    useShellStore().openPalette();
    const wrapper = mountWithI18n(PaletteOverlay, { attachTo: document.body });
    await flushPromises();
    const input = wrapper.get('[data-testid="palette-input"]');
    expect(document.activeElement).toBe(input.element);
    const active = wrapper.get('[data-testid="palette-row"][aria-selected="true"]');
    expect(input.attributes("aria-activedescendant")).toBe(active.attributes("id"));
    await input.trigger("keydown", { key: "ArrowDown" });
    expect(input.attributes("aria-activedescendant")).toBe(
      wrapper.get('[data-testid="palette-row"][aria-selected="true"]').attributes("id"),
    );
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    input.element.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input.element);
    wrapper.unmount();
  });

  it("points the active descendant at the first visible row after typing", async () => {
    useShellStore().openPalette();
    const wrapper = mountWithI18n(PaletteOverlay, { attachTo: document.body });
    await wrapper.findAll('[data-testid="palette-row"]')[3]!.trigger("mousemove");
    const input = wrapper.get('[data-testid="palette-input"]');
    expect(input.attributes("aria-activedescendant")).toBe("palette-option-3");
    await input.setValue("rev");
    const rows = wrapper.findAll('[data-testid="palette-row"]');
    expect(rows).toHaveLength(1);
    expect(input.attributes("aria-activedescendant")).toBe(rows[0]?.attributes("id"));
    expect(rows[0]?.attributes("aria-selected")).toBe("true");
    wrapper.unmount();
  });

  it("gives the focus back to the element that had it when it closes", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const shell = useShellStore();
    shell.openPalette();
    const wrapper = mountWithI18n(PaletteOverlay, { attachTo: document.body });
    await flushPromises();
    const input = wrapper.get('[data-testid="palette-input"]');
    expect(document.activeElement).toBe(input.element);
    await input.trigger("keydown", { key: "Escape" });
    expect(shell.paletteOpen).toBe(false);
    wrapper.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("leaves the focus alone when the previous element is gone", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    useShellStore().openPalette();
    const wrapper = mountWithI18n(PaletteOverlay, { attachTo: document.body });
    await flushPromises();
    opener.remove();
    wrapper.unmount();
    expect(document.activeElement).toBe(document.body);
  });

  it("shows the empty sentence and closes with escape", async () => {
    const shell = useShellStore();
    shell.openPalette();
    const wrapper = mountWithI18n(PaletteOverlay, { attachTo: document.body });
    const input = wrapper.get('[data-testid="palette-input"]');
    await input.setValue("zzzz");
    expect(wrapper.get('[data-testid="palette-empty"]').text()).toBe(
      'No matches for "zzzz". Try a command, branch, file or repository.',
    );
    expect(wrapper.findAll('[data-testid="palette-row"]')).toHaveLength(0);
    await input.trigger("keydown", { key: "Escape" });
    expect(shell.paletteOpen).toBe(false);
    wrapper.unmount();
  });

  it("dims the window and closes on a press on it, not on a selection released there", async () => {
    const shell = useShellStore();
    shell.openPalette();
    const wrapper = mountWithI18n(PaletteOverlay, { attachTo: document.body });
    await flushPromises();
    const scrim = wrapper.get('[data-testid="palette-overlay"]');
    expect(scrim.classes()).toEqual(expect.arrayContaining(["fixed", "inset-0", "bg-shadow"]));
    // A selection dragged from the query past the panel ends as a click on the scrim.
    await wrapper.get('[data-testid="palette-input"]').trigger("pointerdown");
    await scrim.trigger("click");
    expect(shell.paletteOpen).toBe(true);
    await scrim.trigger("pointerdown");
    expect(shell.paletteOpen).toBe(false);
    wrapper.unmount();
  });

  it("keeps the focus in the query when a label is pressed, and closes on Esc from the panel", async () => {
    const shell = useShellStore();
    shell.openPalette();
    const wrapper = mountWithI18n(PaletteOverlay, { attachTo: document.body });
    await flushPromises();
    const panel = wrapper.get('[role="dialog"]');
    expect(panel.attributes("tabindex")).toBe("-1");
    const label = wrapper.get(".palette-section");
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    label.element.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    const onInput = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    wrapper.get('[data-testid="palette-input"]').element.dispatchEvent(onInput);
    expect(onInput.defaultPrevented).toBe(false);
    await panel.trigger("keydown", { key: "Escape" });
    expect(shell.paletteOpen).toBe(false);
    wrapper.unmount();
  });
});
