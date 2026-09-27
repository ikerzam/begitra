import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRepoStore } from "@/stores/repo";
import { memoryStorage } from "@/stores/settings";
import { mountWithI18n } from "@/test/mount";

import App from "./App.vue";

const stored: Record<string, unknown> = {};
vi.mock("@tauri-apps/plugin-store", () => ({
  load: () => Promise.resolve(memoryStorage(stored)),
}));

beforeEach(() => {
  setActivePinia(createPinia());
  for (const key of Object.keys(stored)) delete stored[key];
});

afterEach(() => {
  clearMocks();
});

describe("App", () => {
  it("loads the settings and renders the home with the index error when nothing answers", async () => {
    mockIPC(() => {
      throw new Error("no backend here");
    });
    const wrapper = mountWithI18n(App, { global: { plugins: [createPinia()] } });
    expect(wrapper.find('[data-testid="app-root"]').exists()).toBe(true);
    await flushPromises();
    expect(wrapper.find('[data-testid="app-shell"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="top-bar"]').text()).toContain("No repository open");
    expect(wrapper.find('[data-testid="home-screen"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="index-error"]').text()).toContain(
      "The repository list could not be read.",
    );
    expect(wrapper.get('[data-testid="status-bar"]').text()).toContain("No repositories");
    wrapper.unmount();
  });

  it("shows the empty home with an empty index and no scan folders", async () => {
    mockIPC((cmd) => (cmd === "list_repositories" ? [] : null));
    const wrapper = mountWithI18n(App, { global: { plugins: [createPinia()] } });
    await flushPromises();
    expect(wrapper.find('[data-testid="home-empty"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="status-bar"]').text()).toContain("No repositories");
    wrapper.unmount();
  });

  it("reopens the last repository at launch while the index loads", async () => {
    stored["lastRepository"] = "/r";
    const calls: string[] = [];
    mockIPC((cmd, rawArgs) => {
      calls.push(cmd);
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      switch (cmd) {
        case "list_repositories":
          return [];
        case "open_repository":
          return {
            root: args["path"],
            commonDir: "/r/.git",
            currentBranch: "main",
            detached: false,
            isLinkedWorktree: false,
          };
        case "list_refs":
          return [];
        default:
          return null;
      }
    });
    const wrapper = mountWithI18n(App, { global: { plugins: [createPinia()] } });
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPromises();
    const commands = calls.filter((cmd) => !cmd.startsWith("plugin:"));
    expect(commands.slice(0, 3)).toEqual(["list_repositories", "projects", "open_repository"]);
    expect(useRepoStore().repo?.root).toBe("/r");
    expect(wrapper.get('[data-testid="top-bar"]').text()).toContain("r");
    expect(calls).toContain("watch_repository");
    wrapper.unmount();
  });
});
