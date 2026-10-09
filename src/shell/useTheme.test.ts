import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";

import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { fakeBackend, settled } from "@/test/backend";

import { applyTheme, brightnessOf, hexOf, resolveTheme, useCodeTheme, useTheme } from "./useTheme";

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

  it("applies no theme until the settings are read", async () => {
    setActivePinia(createPinia());
    delete document.documentElement.dataset["theme"];
    const wrapper = mount(Host);
    expect(document.documentElement.dataset["theme"]).toBeUndefined();
    await useSettingsStore().init(memoryStorage({ theme: "light" }), "windows");
    await nextTick();
    expect(document.documentElement.dataset["theme"]).toBe("light");
    wrapper.unmount();
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

  it("reads a computed colour as six hexadecimal digits, and nothing else", () => {
    expect(hexOf("rgb(0, 0, 0)")).toBe("#000000");
    expect(hexOf("rgb(253, 246, 227)")).toBe("#fdf6e3");
    expect(hexOf("rgba(1, 2, 3, 1)")).toBe("#010203");
    for (const color of [
      "rgba(0, 0, 0, 0)",
      "rgba(0, 0, 0, 0.5)",
      "transparent",
      "",
      "rgb(256, 0, 0)",
    ]) {
      expect(hexOf(color)).toBeNull();
    }
  });

  describe("the window's background", () => {
    let tokens: HTMLStyleElement;

    beforeEach(() => {
      tokens = document.createElement("style");
      // As the built stylesheet writes them, as short as they go; the body's background spelled
      // out, since jsdom resolves no var() in a computed colour.
      tokens.textContent =
        'body { background-color: #000; } :root[data-theme="light"] body { background-color: #fff; }';
      document.head.append(tokens);
    });

    afterEach(() => {
      tokens.remove();
      clearMocks();
    });

    const handed = (calls: { cmd: string; args: Record<string, unknown> }[]) =>
      calls
        .filter((call) => call.cmd === "set_window_background")
        .map((call) => call.args["background"]);

    it("is the background of each theme applied", async () => {
      const calls = fakeBackend();
      applyTheme("light");
      applyTheme("dark");
      await settled();
      expect(handed(calls)).toEqual(["#ffffff", "#000000"]);
    });

    it("is not handed over when it reads as no colour, and a refusal changes nothing", async () => {
      const calls = fakeBackend();
      tokens.remove();
      applyTheme("light");
      await settled();
      expect(handed(calls)).toEqual([]);
      document.head.append(tokens);
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
      mockIPC(() => Promise.reject({ code: "ipc.invalid_argument", message: "Invalid argument" }));
      expect(applyTheme("light")).toBe("light");
      await settled();
      expect(document.documentElement.dataset["theme"]).toBe("light");
    });
  });
});
