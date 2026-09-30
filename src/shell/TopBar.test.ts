import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { useProjectDialogsStore } from "@/stores/projectDialogs";
import { useProjectsStore } from "@/stores/projects";
import { memoryStorage, useSettingsStore } from "@/stores/settings";
import { fakeBackend } from "@/test/backend";
import { folderProjectOf, projectOf } from "@/test/entries";
import { mountWithI18n } from "@/test/mount";

import TopBar from "./TopBar.vue";

const props = {
  layoutMode: "graph" as const,
  changedCount: 5,
  canShowChanges: true,
  canShowOverview: true,
};

beforeEach(async () => {
  setActivePinia(createPinia());
  setShortcutRegistry(new ShortcutRegistry("windows"));
  await useSettingsStore().init(memoryStorage(), "windows");
  fakeBackend({
    projects: [
      projectOf(1, "Geoportal", ["/code/api", "/code/web"], { pinned: true }),
      folderProjectOf(2, "/home/iker/code", [], [], { openedAt: 20 }),
      projectOf(3, "tiles", ["/tmp/tiles"], { openedAt: 10 }),
      projectOf(4, "never opened", []),
    ],
  });
});

afterEach(() => {
  clearMocks();
  setShortcutRegistry(undefined);
});

describe("TopBar", () => {
  it("gives the layout buttons the app's tooltip with the shortcut hint, and no native title", () => {
    const wrapper = mountWithI18n(TopBar, { props, attachTo: document.body });
    const hints = ["settings", "graph", "review", "changes", "overview"].map((mode) => {
      const button = wrapper.get(`[data-testid="mode-${mode}"]`);
      expect(button.attributes("title")).toBeUndefined();
      return [button.attributes("data-tooltip"), button.attributes("data-tooltip-keys")];
    });
    expect(hints).toEqual([
      ["Settings", "Ctrl ,"],
      ["Graph focus", "Ctrl 1"],
      ["Review focus", "Ctrl 2"],
      ["Changes", "Ctrl 3"],
      ["Project overview", "Ctrl 4"],
    ]);
    // The Changes toggle's name carries its count; its tooltip names the screen.
    expect(wrapper.get('[data-testid="mode-changes"]').attributes("aria-label")).toContain("5");
    wrapper.unmount();
  });

  it("offers the Overview only while the project holds more than one repository", async () => {
    const wrapper = mountWithI18n(TopBar, { props: { ...props, canShowOverview: false } });
    expect(wrapper.find('[data-testid="mode-overview"]').exists()).toBe(false);
    await wrapper.setProps({ canShowOverview: true, layoutMode: "overview" });
    const toggle = wrapper.get('[data-testid="mode-overview"]');
    expect(toggle.attributes("aria-pressed")).toBe("true");
    await toggle.trigger("click");
    expect(wrapper.emitted("setLayoutMode")).toEqual([["overview"]]);
    wrapper.unmount();
  });

  it("names the open project in the switcher, lists the pinned and recent ones, and marks it", async () => {
    const projects = useProjectsStore();
    await projects.load();
    useSettingsStore().values.activeProject = 3;
    const wrapper = mountWithI18n(TopBar, { props, attachTo: document.body });
    await flushPromises();
    expect(wrapper.get('[data-testid="project-switcher"]').text()).toBe("tiles");
    await wrapper.get('[data-testid="project-switcher"]').trigger("click");
    const menu = wrapper.get('[data-testid="project-switcher-menu"]');
    const items = menu.findAll('[role="menuitem"]').map((item) => item.text());
    expect(items).toEqual([
      "Geoportal2 repositories",
      "code/home/iker/code",
      "tiles1 repository",
      "Go to projects",
      "Open folder…",
      "New project…",
    ]);
    const current = menu
      .findAll('[role="menuitem"]')
      .filter((item) => item.attributes("aria-current"));
    expect(current.map((item) => item.text())).toEqual(["tiles1 repository"]);
    await menu.get('[data-testid="switcher-new-project"]').trigger("click");
    expect(useProjectDialogsStore().creating).toBe(true);
    wrapper.unmount();
  });

  it("says no project is open, and passes Open folder… up", async () => {
    const wrapper = mountWithI18n(TopBar, { props, attachTo: document.body });
    expect(wrapper.get('[data-testid="project-switcher"]').text()).toBe("No project open");
    await wrapper.get('[data-testid="project-switcher"]').trigger("click");
    expect(wrapper.get('[data-testid="switcher-home"]').attributes("aria-disabled")).toBe("true");
    await wrapper.get('[data-testid="switcher-open-folder"]').trigger("click");
    expect(wrapper.emitted("openFolder")).toHaveLength(1);
    wrapper.unmount();
  });

  it("counts the changed files on the Changes toggle, names ⌘3 and opens the changes", async () => {
    const wrapper = mountWithI18n(TopBar, { props, attachTo: document.body });
    const toggle = wrapper.get('[data-testid="mode-changes"]');
    expect(toggle.get('[data-testid="icon-button-count"]').text()).toBe("5");
    expect(toggle.attributes("aria-label")).toBe("Changes, 5 files changed");
    expect(toggle.attributes("aria-pressed")).toBe("false");
    expect(toggle.attributes("data-tooltip")).toBe("Changes");
    expect(toggle.attributes("data-tooltip-keys")).toBe("Ctrl 3");
    await toggle.trigger("click");
    expect(wrapper.emitted("setLayoutMode")).toEqual([["changes"]]);

    // On the changes, clean: pressed, no count.
    await wrapper.setProps({ layoutMode: "changes", changedCount: 0 });
    expect(toggle.attributes("aria-pressed")).toBe("true");
    expect(toggle.find('[data-testid="icon-button-count"]').exists()).toBe(false);
    expect(toggle.attributes("aria-label")).toBe("Changes");
    wrapper.unmount();
  });

  it("disables the Changes toggle with nothing to show", () => {
    const wrapper = mountWithI18n(TopBar, {
      props: { ...props, changedCount: 0, canShowChanges: false },
    });
    expect(wrapper.get('[data-testid="mode-changes"]').attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
});
