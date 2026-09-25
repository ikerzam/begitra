import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { mountWithI18n } from "@/test/mount";

import TopBar from "./TopBar.vue";

beforeEach(() => {
  setActivePinia(createPinia());
  setShortcutRegistry(new ShortcutRegistry("windows"));
  mockIPC(() => null);
});

afterEach(() => {
  clearMocks();
  setShortcutRegistry(undefined);
});

describe("TopBar", () => {
  it("gives the layout buttons the app's tooltip with the shortcut hint, and no native title", () => {
    const wrapper = mountWithI18n(TopBar, {
      props: {
        repositoryName: null,
        repositoryRoot: null,
        layoutMode: "graph",
        changedCount: 5,
        canShowChanges: true,
      },
      attachTo: document.body,
    });
    const hints = ["settings", "graph", "review", "changes"].map((mode) => {
      const button = wrapper.get(`[data-testid="mode-${mode}"]`);
      expect(button.attributes("title")).toBeUndefined();
      return [button.attributes("data-tooltip"), button.attributes("data-tooltip-keys")];
    });
    expect(hints).toEqual([
      ["Settings", "Ctrl ,"],
      ["Graph focus", "Ctrl 1"],
      ["Review focus", "Ctrl 2"],
      ["Changes", "Ctrl 3"],
    ]);
    // The Changes toggle's name carries its count; its tooltip names the screen.
    expect(wrapper.get('[data-testid="mode-changes"]').attributes("aria-label")).toContain("5");
    wrapper.unmount();
  });

  it("names the open repository in the switcher and passes Open folder… up", async () => {
    const wrapper = mountWithI18n(TopBar, {
      props: {
        repositoryName: "geoportal",
        repositoryRoot: "/r/geoportal",
        layoutMode: "graph",
        changedCount: 0,
        canShowChanges: true,
      },
      attachTo: document.body,
    });
    expect(wrapper.get('[data-testid="repo-switcher"]').text()).toBe("geoportal");
    await wrapper.get('[data-testid="repo-switcher"]').trigger("click");
    await wrapper.get('[data-testid="switcher-open-folder"]').trigger("click");
    expect(wrapper.emitted("openFolder")).toHaveLength(1);
    wrapper.unmount();
  });

  it("counts the changed files on the Changes toggle, names ⌘3 and opens the changes screen", async () => {
    const wrapper = mountWithI18n(TopBar, {
      props: {
        repositoryName: "geoportal",
        repositoryRoot: "/r/geoportal",
        layoutMode: "graph",
        changedCount: 5,
        canShowChanges: true,
      },
      attachTo: document.body,
    });
    const toggle = wrapper.get('[data-testid="mode-changes"]');
    expect(toggle.get('[data-testid="icon-button-count"]').text()).toBe("5");
    expect(toggle.attributes("aria-label")).toBe("Changes, 5 files changed");
    expect(toggle.attributes("aria-pressed")).toBe("false");
    expect(toggle.attributes("data-tooltip")).toBe("Changes");
    expect(toggle.attributes("data-tooltip-keys")).toBe("Ctrl 3");
    await toggle.trigger("click");
    expect(wrapper.emitted("setLayoutMode")).toEqual([["changes"]]);

    // On the changes screen, clean: pressed, no count.
    await wrapper.setProps({ layoutMode: "changes", changedCount: 0 });
    expect(toggle.attributes("aria-pressed")).toBe("true");
    expect(toggle.find('[data-testid="icon-button-count"]').exists()).toBe(false);
    expect(toggle.attributes("aria-label")).toBe("Changes");
    wrapper.unmount();
  });

  it("disables the Changes toggle without a ready repository", () => {
    const wrapper = mountWithI18n(TopBar, {
      props: {
        repositoryName: null,
        repositoryRoot: null,
        layoutMode: "graph",
        changedCount: 0,
        canShowChanges: false,
      },
    });
    expect(wrapper.get('[data-testid="mode-changes"]').attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
});
