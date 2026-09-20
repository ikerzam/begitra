import type { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IndexEntry } from "@/ipc/schemas";
import { useIndexStore } from "@/stores/index";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { mountWithI18n } from "@/test/mount";

import RepoSwitcher from "./RepoSwitcher.vue";

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
      dirty: null,
    },
    pinned: false,
    lastOpenedAt: null,
    refreshedAt: null,
    missing: false,
    ...over,
  };
}

const entries = [
  entry("geoportal", { pinned: true }),
  entry("begira", { lastOpenedAt: 30 }),
  entry("tiles-spike", { lastOpenedAt: 20 }),
  entry("alpha", { lastOpenedAt: 6 }),
  entry("beta", { lastOpenedAt: 5 }),
  entry("gamma", { lastOpenedAt: 4 }),
  entry("delta", { lastOpenedAt: 3 }),
  entry("epsilon", { lastOpenedAt: 2 }),
  entry("zeta"),
];

function backend() {
  const calls: string[] = [];
  mockIPC((cmd, rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    calls.push(cmd);
    switch (cmd) {
      case "list_repositories":
        return entries;
      case "open_repository":
        return {
          root: args["path"],
          commonDir: `${args["path"] as string}/.git`,
          currentBranch: "main",
          detached: false,
          isLinkedWorktree: false,
        };
      case "list_refs":
        return [];
      case "close_repository":
        return true;
      case "walk_commits":
        queueMicrotask(() => {
          const channel = args["onPage"] as Channel<unknown>;
          channel.onmessage({
            kind: "page",
            seq: 0,
            data: { walkId: "w", index: 0, commits: [], done: true },
          });
          channel.onmessage({ kind: "done" });
        });
        return null;
      default:
        return null;
    }
  });
  return calls;
}

function mountSwitcher(root: string | null = "/code/begira") {
  return mountWithI18n(RepoSwitcher, {
    props: { repositoryName: root ? root.split("/").pop()! : null, repositoryRoot: root },
    attachTo: document.body,
  });
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "linux");
  backend();
  const index = useIndexStore();
  index.entries = entries;
  index.loaded = true;
});

afterEach(() => {
  clearMocks();
});

describe("RepoSwitcher", () => {
  it("opens a menu with the pinned and the five most recent repositories, the current one marked", async () => {
    const wrapper = mountSwitcher();
    const button = wrapper.get('[data-testid="repo-switcher"]');
    expect(button.text()).toBe("begira");
    expect(button.attributes("aria-expanded")).toBe("false");
    expect(wrapper.find('[data-testid="repo-switcher-menu"]').exists()).toBe(false);
    await button.trigger("click");
    const menu = wrapper.get('[data-testid="repo-switcher-menu"]');
    expect(button.attributes("aria-expanded")).toBe("true");
    const items = menu.findAll("[role='menuitem']");
    expect(items.map((item) => item.text())).toEqual([
      "geoportal/code/geoportal",
      "begira/code/begira",
      "tiles-spike/code/tiles-spike",
      "alpha/code/alpha",
      "beta/code/beta",
      "gamma/code/gamma",
      "Go to repositories",
      "Open folder…",
    ]);
    expect(menu.text()).toContain("Pinned");
    expect(menu.text()).toContain("Recent");
    expect(items[1]?.attributes("aria-current")).toBe("true");
    expect(items[0]?.attributes("aria-current")).toBeUndefined();
    expect(menu.findAll("[role='separator']")).toHaveLength(1);
    // The first item has the focus, ready for the arrows.
    expect(document.activeElement).toBe(items[0]?.element);
    wrapper.unmount();
  });

  it("opens the chosen repository and closes", async () => {
    const wrapper = mountSwitcher();
    await wrapper.get('[data-testid="repo-switcher"]').trigger("click");
    await wrapper.get("[data-path='/code/tiles-spike']").trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="repo-switcher-menu"]').exists()).toBe(false);
    expect(useRepoStore().state.kind).toBe("ready");
    expect(useRepoStore().repo?.root).toBe("/code/tiles-spike");
    expect(document.activeElement).toBe(wrapper.get('[data-testid="repo-switcher"]').element);
    wrapper.unmount();
  });

  it("goes home, opens a folder, and closes with escape", async () => {
    const repo = useRepoStore();
    await repo.open("/code/begira");
    await flushPromises();
    const wrapper = mountSwitcher();
    await wrapper.get('[data-testid="repo-switcher"]').trigger("keydown", { key: "ArrowDown" });
    expect(wrapper.find('[data-testid="repo-switcher-menu"]').exists()).toBe(true);
    await wrapper.get('[data-testid="switcher-home"]').trigger("click");
    await flushPromises();
    expect(repo.state.kind).toBe("empty");

    await wrapper.get('[data-testid="repo-switcher"]').trigger("click");
    expect(wrapper.get('[data-testid="switcher-home"]').attributes("aria-disabled")).toBe("true");
    await wrapper.get('[data-testid="switcher-open-folder"]').trigger("click");
    expect(wrapper.emitted("openFolder")).toHaveLength(1);

    await wrapper.get('[data-testid="repo-switcher"]').trigger("click");
    await wrapper.get('[data-testid="repo-switcher-menu"]').trigger("keydown", { key: "Escape" });
    expect(wrapper.find('[data-testid="repo-switcher-menu"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it("offers only the two actions without an index", async () => {
    useIndexStore().entries = [];
    const wrapper = mountSwitcher(null);
    expect(wrapper.get('[data-testid="repo-switcher"]').text()).toBe("No repository open");
    await wrapper.get('[data-testid="repo-switcher"]').trigger("click");
    const menu = wrapper.get('[data-testid="repo-switcher-menu"]');
    expect(menu.findAll("[role='menuitem']").map((item) => item.text())).toEqual([
      "Go to repositories",
      "Open folder…",
    ]);
    expect(menu.findAll("[role='separator']")).toHaveLength(0);
    wrapper.unmount();
  });
});
