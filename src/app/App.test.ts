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
    expect(wrapper.get('[data-testid="top-bar"]').text()).toContain("No project open");
    expect(wrapper.find('[data-testid="home-screen"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="projects-error"]').text()).toContain(
      "Couldn't read the list of projects.",
    );
    expect(wrapper.get('[data-testid="status-bar"]').text()).toContain("No repositories");
    wrapper.unmount();
  });

  it("shows the empty home without a project", async () => {
    mockIPC((cmd) => (cmd === "list_repositories" || cmd === "projects" ? [] : null));
    const wrapper = mountWithI18n(App, { global: { plugins: [createPinia()] } });
    await flushPromises();
    expect(wrapper.find('[data-testid="home-empty"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="status-bar"]').text()).toContain("No repositories");
    wrapper.unmount();
  });

  it("reopens the open project's repository at launch while the index loads", async () => {
    stored["activeProject"] = 1;
    const calls: string[] = [];
    mockIPC((cmd, rawArgs) => {
      calls.push(cmd);
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      switch (cmd) {
        case "list_repositories":
          return [];
        case "projects":
          return [
            {
              id: 1,
              name: "Geoportal",
              kind: "list",
              folder: null,
              members: [{ path: "/r", origin: "hand" }],
              pinned: false,
              openedAt: 1,
              lastRepository: "/r",
              createdAt: 1,
              updatedAt: 1,
            },
          ];
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
    await vi.waitFor(() => expect(useRepoStore().state.kind).toBe("ready"));
    const commands = calls.filter((cmd) => !cmd.startsWith("plugin:"));
    // The projects name the repository to reopen; the index loads beside the open.
    expect(commands.slice(0, 2)).toEqual(["list_repositories", "projects"]);
    expect(commands).toContain("open_repository");
    expect(useRepoStore().repo?.root).toBe("/r");
    expect(wrapper.get('[data-testid="top-bar"]').text()).toContain("Geoportal");
    expect(calls).toContain("watch_repository");
    wrapper.unmount();
  });
});
