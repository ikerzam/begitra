import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import App from "./App.vue";

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  clearMocks();
});

describe("App", () => {
  it("loads the settings, falls back to memory outside Tauri and renders the empty shell", async () => {
    mockIPC(() => {
      throw new Error("no store here");
    });
    const wrapper = mountWithI18n(App, { global: { plugins: [createPinia()] } });
    expect(wrapper.find('[data-testid="app-root"]').exists()).toBe(true);
    await flushPromises();
    expect(wrapper.find('[data-testid="app-shell"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="top-bar"]').text()).toContain("No repository open");
    expect(wrapper.find('[data-testid="home-empty"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="status-bar"]').text()).toContain("No repositories");
    wrapper.unmount();
  });
});
