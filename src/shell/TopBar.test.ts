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
      props: { repositoryName: null, repositoryRoot: null, layoutMode: "graph" },
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
      props: { repositoryName: "geoportal", repositoryRoot: "/r/geoportal", layoutMode: "graph" },
      attachTo: document.body,
    });
    expect(wrapper.get('[data-testid="repo-switcher"]').text()).toBe("geoportal");
    await wrapper.get('[data-testid="repo-switcher"]').trigger("click");
    await wrapper.get('[data-testid="switcher-open-folder"]').trigger("click");
    expect(wrapper.emitted("openFolder")).toHaveLength(1);
    wrapper.unmount();
  });
});
