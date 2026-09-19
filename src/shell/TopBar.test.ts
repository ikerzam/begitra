import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { mountWithI18n } from "@/test/mount";

import TopBar from "./TopBar.vue";

beforeEach(() => {
  setShortcutRegistry(new ShortcutRegistry("windows"));
});

afterEach(() => {
  setShortcutRegistry(undefined);
});

describe("TopBar", () => {
  it("shows a tooltip with the shortcut hint on the layout buttons instead of a native title", async () => {
    const wrapper = mountWithI18n(TopBar, {
      props: { repositoryName: null, layoutMode: "graph" },
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
});
