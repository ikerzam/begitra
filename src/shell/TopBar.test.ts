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
  it("shows a tooltip with the shortcut hint on the layout buttons instead of a native title", async () => {
    const wrapper = mountWithI18n(TopBar, {
      props: {
        repositoryName: null,
        repositoryRoot: null,
        layoutMode: "graph",
        changedCount: 0,
        canShowChanges: false,
      },
      attachTo: document.body,
    });
    const button = wrapper.get('[data-testid="mode-graph"]');
    expect(button.attributes("title")).toBeUndefined();
    expect(button.attributes("aria-label")).toBe("Graph focus");
    expect(wrapper.find("[role='tooltip']").exists()).toBe(false);

    await wrapper.get('[data-testid="tooltip-graph"]').trigger("mouseenter");
    const tooltip = wrapper.get("[role='tooltip']");
    expect(tooltip.text()).toContain("Graph focus");
    expect(tooltip.get("kbd").text()).toBe("Ctrl 1");
    expect(button.attributes("aria-describedby")).toBe(tooltip.attributes("id"));

    await wrapper.get('[data-testid="tooltip-graph"]').trigger("mouseleave");
    await wrapper.get('[data-testid="tooltip-review"]').trigger("focusin");
    expect(wrapper.get("[role='tooltip']").get("kbd").text()).toBe("Ctrl 2");
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
    await wrapper.get('[data-testid="tooltip-changes"]').trigger("mouseenter");
    const tooltip = wrapper.get("[role='tooltip']");
    expect(tooltip.text()).toContain("Changes");
    expect(tooltip.get("kbd").text()).toBe("Ctrl 3");
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
