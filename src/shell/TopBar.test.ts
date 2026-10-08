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

const props = { settingsShown: false, showSync: false };

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
  it("shows Fetch, Pull and Push after the project switcher only while asked to", async () => {
    const wrapper = mountWithI18n(TopBar, { props, attachTo: document.body });
    expect(wrapper.find('[data-testid="sync-buttons"]').exists()).toBe(false);
    await wrapper.setProps({ showSync: true });
    const group = wrapper.get('[data-testid="sync-buttons"]');
    expect(group.findAll("button").map((button) => button.attributes("aria-label"))).toEqual([
      "Fetch",
      "Pull",
      "Push",
    ]);
    // After the switcher and a divider, before the palette trigger.
    const switcher = wrapper.get('[data-testid="project-switcher"]').element;
    const palette = wrapper.get('[data-testid="palette-trigger"]').element;
    const after = (a: Element, b: Element) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(after(switcher, group.element)).toBe(true);
    expect(after(group.element, palette)).toBe(true);
    expect(group.attributes("aria-label")).toBe("Sync with the remote");
    wrapper.unmount();
  });

  it("holds the gear alone after the palette, the views being tabs, with the app's tooltip", async () => {
    const wrapper = mountWithI18n(TopBar, { props, attachTo: document.body });
    for (const mode of ["graph", "review", "changes", "overview"]) {
      expect(wrapper.find(`[data-testid="mode-${mode}"]`).exists()).toBe(false);
    }
    const gear = wrapper.get('[data-testid="mode-settings"]');
    expect(gear.attributes("title")).toBeUndefined();
    expect(gear.attributes("data-tooltip")).toBe("Settings");
    expect(gear.attributes("data-tooltip-keys")).toBe("Ctrl ,");
    expect(gear.attributes("aria-pressed")).toBe("false");
    await gear.trigger("click");
    expect(wrapper.emitted("openSettings")).toHaveLength(1);
    // Pressed while the settings' tab shows.
    await wrapper.setProps({ settingsShown: true });
    expect(gear.attributes("aria-pressed")).toBe("true");
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

  it("closes the switcher before its item acts, the button focused, so a dialog returns there", async () => {
    // A browser renders between the item's click listener and the menu's own: after the item's
    // listener alone the menu is closed and the button has the focus, which the New project
    // dialog records as the place to return to.
    const wrapper = mountWithI18n(TopBar, { props, attachTo: document.body });
    await wrapper.get('[data-testid="project-switcher"]').trigger("click");
    wrapper
      .get('[data-testid="switcher-new-project"]')
      .element.dispatchEvent(new MouseEvent("click", { bubbles: false }));
    await flushPromises();
    expect(wrapper.find('[data-testid="project-switcher-menu"]').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('[data-testid="project-switcher"]').element);
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
});
