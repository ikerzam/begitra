import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
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

describe("PaletteOverlay", () => {
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
});
