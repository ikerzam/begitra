import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRepoStore } from "@/stores/repo";
import { memoryStorage } from "@/stores/settings";
import { mountWithI18n } from "@/test/mount";

import App from "./App.vue";

const stored: Record<string, unknown> = {};
/** The store refuses to delete a key, as a file another process holds would. */
let refuseDelete = false;
vi.mock("@tauri-apps/plugin-store", () => ({
  load: () => {
    const storage = memoryStorage(stored);
    if (refuseDelete) storage.delete = () => Promise.reject(new Error("the file is locked"));
    return Promise.resolve(storage);
  },
}));

beforeEach(() => {
  setActivePinia(createPinia());
  for (const key of Object.keys(stored)) delete stored[key];
  refuseDelete = false;
});

afterEach(() => {
  clearMocks();
});

describe("App", () => {
  it("keeps the start-up screen until the settings are read, then shows the shell in its theme", async () => {
    stored["theme"] = "light";
    mockIPC((cmd) => (cmd === "list_repositories" || cmd === "projects" ? [] : null));
    delete document.documentElement.dataset["theme"];
    const screen = document.createElement("div");
    screen.className = "boot";
    document.body.append(screen);
    const wrapper = mountWithI18n(App, { global: { plugins: [createPinia()] } });
    // Nothing of the app's own over the window's background yet, and no default theme.
    expect(screen.isConnected).toBe(true);
    expect(document.documentElement.dataset["theme"]).toBeUndefined();
    expect(wrapper.get('[data-testid="app-root"]').classes()).not.toContain("bg-app");
    await flushPromises();
    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(wrapper.get('[data-testid="app-root"]').classes()).toContain("bg-app");
    expect(wrapper.find('[data-testid="app-shell"]').exists()).toBe(true);
    expect(screen.isConnected).toBe(false);
    wrapper.unmount();
    delete document.documentElement.dataset["theme"];
  });

  it("opens no menu on a right click until the shell is there", async () => {
    mockIPC((cmd) => (cmd === "list_repositories" || cmd === "projects" ? [] : null));
    const wrapper = mountWithI18n(App, { global: { plugins: [createPinia()] } });
    const click = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    await flushPromises();
    wrapper.unmount();
  });

  it("keeps the settings it read when a write that tidies them fails", async () => {
    // An earlier version's key, which the read retires with a delete the store refuses.
    stored["theme"] = "light";
    stored["layoutMode"] = "graph";
    refuseDelete = true;
    mockIPC((cmd) => (cmd === "list_repositories" || cmd === "projects" ? [] : null));
    const wrapper = mountWithI18n(App, { global: { plugins: [createPinia()] } });
    await flushPromises();
    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(wrapper.find('[data-testid="app-shell"]').exists()).toBe(true);
    wrapper.unmount();
    delete document.documentElement.dataset["theme"];
  });

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
