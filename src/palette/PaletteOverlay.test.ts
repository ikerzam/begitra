import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
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

  it("shows the empty sentence and closes with escape", async () => {
    const shell = useShellStore();
    shell.openPalette();
    const wrapper = mountWithI18n(PaletteOverlay, { attachTo: document.body });
    const input = wrapper.get('[data-testid="palette-input"]');
    await input.setValue("zzzz");
    expect(wrapper.get('[data-testid="palette-empty"]').text()).toBe(
      "Nothing matches. Try another word.",
    );
    await input.trigger("keydown", { key: "Escape" });
    expect(shell.paletteOpen).toBe(false);
    wrapper.unmount();
  });
});
