import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import TabsItem from "./TabsItem.vue";

describe("TabsItem", () => {
  it("renders an inactive tab in secondary text with a transparent underline", () => {
    const wrapper = mountWithI18n(TabsItem, { props: { label: "Repos", controls: "panel-repos" } });
    expect(wrapper.element.tagName).toBe("BUTTON");
    expect(wrapper.attributes("role")).toBe("tab");
    expect(wrapper.attributes("aria-selected")).toBe("false");
    expect(wrapper.attributes("aria-controls")).toBe("panel-repos");
    expect(wrapper.text()).toBe("Repos");
    expect(wrapper.classes()).toContain("text-fg-secondary");
    expect(wrapper.classes()).toContain("border-transparent");
    expect(wrapper.classes()).toContain("h-panel-header");
    expect(wrapper.classes().some((c) => /^p[xlr]-/.test(c))).toBe(false);
  });

  it("underlines the active tab in --text, never in the accent", () => {
    const wrapper = mountWithI18n(TabsItem, { props: { label: "Branches", selected: true } });
    expect(wrapper.attributes("aria-selected")).toBe("true");
    expect(wrapper.classes()).toContain("border-fg");
    expect(wrapper.classes()).toContain("text-fg");
    expect(wrapper.classes()).not.toContain("border-accent");
  });

  it("emits select on click and takes slot content", async () => {
    const wrapper = mountWithI18n(TabsItem, { slots: { default: "Worktrees" } });
    expect(wrapper.text()).toBe("Worktrees");
    await wrapper.trigger("click");
    expect(wrapper.emitted("select")).toHaveLength(1);
  });
});
