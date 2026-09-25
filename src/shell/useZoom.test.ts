import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";

import { ShortcutRegistry, setShortcutRegistry, shortcutRegistry } from "@/shortcuts/registry";
import { memoryStorage, useSettingsStore } from "@/stores/settings";

import { stepZoom, useZoom } from "./useZoom";

const setZoom = vi.fn<(factor: number) => Promise<void>>(() => Promise.resolve());
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom }) }));

const Host = defineComponent({
  setup() {
    useZoom();
    return () => h("div");
  },
});

beforeEach(async () => {
  setActivePinia(createPinia());
  setShortcutRegistry(new ShortcutRegistry("windows"));
  await useSettingsStore().init(memoryStorage(), "windows");
  setZoom.mockClear();
});

afterEach(() => {
  setShortcutRegistry(undefined);
});

describe("stepZoom", () => {
  it("moves one level and stops at the ends", () => {
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(110, -1)).toBe(100);
    expect(stepZoom(200, 1)).toBe(200);
    expect(stepZoom(80, -1)).toBe(80);
  });
});

describe("useZoom", () => {
  it("scales the webview to the setting and steps it with the shortcuts", async () => {
    const settings = useSettingsStore();
    const wrapper = mount(Host);
    await nextTick();
    expect(setZoom).toHaveBeenLastCalledWith(1);
    expect(shortcutRegistry().run("zoom-in")).toBe(true);
    await nextTick();
    expect(settings.values.zoom).toBe(110);
    expect(setZoom).toHaveBeenLastCalledWith(1.1);
    shortcutRegistry().run("zoom-out");
    shortcutRegistry().run("zoom-out");
    await nextTick();
    expect(settings.values.zoom).toBe(90);
    shortcutRegistry().run("zoom-reset");
    await nextTick();
    expect(settings.values.zoom).toBe(100);
    expect(setZoom).toHaveBeenLastCalledWith(1);
    wrapper.unmount();
    expect(shortcutRegistry().run("zoom-in")).toBe(false);
  });
});
