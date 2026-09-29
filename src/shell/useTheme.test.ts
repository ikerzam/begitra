import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";

import { memoryStorage, useSettingsStore } from "@/stores/settings";

import { applyTheme, brightnessOf, resolveTheme, useCodeTheme, useTheme } from "./useTheme";

/** A `matchMedia` whose light query answers `light`, with its listeners exposed. */
function fakeMatchMedia(light: boolean) {
  const listeners = new Set<() => void>();
  const list = {
    matches: light,
    media: "(prefers-color-scheme: light)",
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  const matchMedia = vi.fn(() => list as unknown as MediaQueryList);
  return {
    matchMedia,
    list,
    listeners,
    setLight(value: boolean) {
      list.matches = value;
      for (const listener of listeners) listener();
    },
  };
}

const Host = defineComponent({
  setup() {
    useTheme();
    return () => h("div");
  },
});

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
  delete document.documentElement.dataset["theme"];
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset["theme"];
});

describe("useTheme", () => {
  it("resolves the setting, dark when the platform cannot say", () => {
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("system")).toBe("dark");
    expect(applyTheme("light")).toBe("light");
    expect(document.documentElement.dataset["theme"]).toBe("light");
  });

  it("writes the setting on the document root and follows its changes", async () => {
    const settings = useSettingsStore();
    const wrapper = mount(Host);
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    await settings.update("theme", "light");
    await nextTick();
    expect(document.documentElement.dataset["theme"]).toBe("light");
    await settings.update("theme", "dark");
    await nextTick();
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    wrapper.unmount();
  });

  it("writes a palette theme as it is and knows its brightness", async () => {
    const settings = useSettingsStore();
    const wrapper = mount(Host);
    await settings.update("theme", "ayu-light");
    await nextTick();
    expect(document.documentElement.dataset["theme"]).toBe("ayu-light");
    expect(brightnessOf("ayu-light")).toBe("light");
    expect(brightnessOf("tokyo-night")).toBe("dark");
    expect(brightnessOf("light")).toBe("light");
    wrapper.unmount();
  });

  it("gives the diff's body the code theme, nothing for the window's", async () => {
    const settings = useSettingsStore();
    const codeTheme = useCodeTheme();
    expect(codeTheme.value).toBeUndefined();
    await settings.update("codeTheme", "solarized-light");
    expect(codeTheme.value).toBe("solarized-light");
    await settings.update("codeTheme", "app");
    expect(codeTheme.value).toBeUndefined();
  });

  it("follows the platform for system, while it runs, and lets go on unmount", async () => {
    const media = fakeMatchMedia(true);
    vi.stubGlobal("matchMedia", media.matchMedia);
    const settings = useSettingsStore();
    const wrapper = mount(Host);
    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(media.listeners.size).toBe(1);
    media.setLight(false);
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    // An explicit theme ignores the platform.
    await settings.update("theme", "light");
    await nextTick();
    media.setLight(true);
    media.setLight(false);
    expect(document.documentElement.dataset["theme"]).toBe("light");
    wrapper.unmount();
    expect(media.listeners.size).toBe(0);
  });
});
