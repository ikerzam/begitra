import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IndexEntry } from "@/ipc/schemas";
import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { useIndexStore } from "@/stores/index";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
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

function entry(name: string, over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    path: `/code/${name}`,
    name,
    kind: "main",
    parentPath: null,
    scanRoot: "/code",
    summary: {
      currentBranch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      lastCommitAt: null,
      upstream: null,
      operation: null,
      fetchedAt: null,
      lastCommitSubject: null,
      dirty: null,
    },
    pinned: false,
    lastOpenedAt: null,
    refreshedAt: null,
    missing: false,
    ...over,
  };
}

describe("PaletteOverlay", () => {
  it("lists the matching repositories under Repos with their path and opens the chosen one", async () => {
    const index = useIndexStore();
    index.entries = [
      entry("geoportal", { pinned: true }),
      entry("begitra"),
      entry("geoportal-infra"),
    ];
    index.loaded = true;
    clearMocks();
    const calls: string[] = [];
    mockIPC((cmd, rawArgs) => {
      calls.push(cmd);
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      if (cmd === "open_repository") {
        return {
          root: args["path"],
          commonDir: `${args["path"] as string}/.git`,
          currentBranch: "main",
          detached: false,
          isLinkedWorktree: false,
        };
      }
      if (cmd === "list_repositories") return index.entries;
      if (cmd === "list_refs") return [];
      return null;
    });
    const shell = useShellStore();
    shell.openPalette();
    const wrapper = mountWithI18n(PaletteOverlay, { attachTo: document.body });
    // With an empty query only the pinned and recent repositories are listed.
    const list = wrapper.get('[data-testid="palette-list"]');
    expect(list.text()).toContain("Repos");
    expect(wrapper.findAll('[data-testid="palette-row-context"]').map((c) => c.text())).toEqual([
      "/code/geoportal",
    ]);
    const input = wrapper.get('[data-testid="palette-input"]');
    await input.setValue("geo");
    const rows = wrapper.findAll('[data-testid="palette-row"]');
    expect(rows.map((r) => r.text())).toEqual([
      "geoportal/code/geoportal",
      "geoportal-infra/code/geoportal-infra",
    ]);
    await input.trigger("keydown", { key: "ArrowDown" });
    await input.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(shell.paletteOpen).toBe(false);
    expect(calls).toContain("open_repository");
    expect(useRepoStore().repo?.root).toBe("/code/geoportal-infra");
    expect(useSettingsStore().values.paletteRecents).toEqual([]);
    wrapper.unmount();
  });

  it("lists the commands with their hints, filters, runs with enter and closes", async () => {
    const shell = useShellStore();
    shell.openPalette();
    const wrapper = mountWithI18n(PaletteOverlay, { attachTo: document.body });
    const rows = wrapper.findAll('[data-testid="palette-row"]');
    expect(rows.map((r) => r.text())).toContain("Switch to review focusCtrl 2");
    expect(rows.some((r) => r.text().includes("Open in terminal"))).toBe(false);

    const input = wrapper.get('[data-testid="palette-input"]');
    await input.setValue("rev");
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
