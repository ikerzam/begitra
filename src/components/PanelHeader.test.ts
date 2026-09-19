import { ListFilter } from "@lucide/vue";
import { describe, expect, it } from "vitest";
import { h } from "vue";

import { mountWithI18n } from "@/test/mount";

import IconButton from "./IconButton.vue";
import PanelHeader from "./PanelHeader.vue";

describe("PanelHeader", () => {
  it("is a 32px header with the title, a muted count and a hairline below", () => {
    const wrapper = mountWithI18n(PanelHeader, { props: { title: "Files", count: 48 } });
    expect(wrapper.element.tagName).toBe("HEADER");
    expect(wrapper.classes()).toContain("h-panel-header");
    expect(wrapper.classes()).toContain("border-b");
    expect(wrapper.classes()).toContain("border-line");
    const title = wrapper.get("[data-testid='panel-header-title']");
    expect(title.text()).toBe("Files");
    expect(title.classes()).toContain("font-medium");
    const count = wrapper.get("[data-testid='panel-header-count']");
    expect(count.text()).toBe("48");
    expect(count.classes()).toContain("text-fg-muted");
    expect(wrapper.find("[data-testid='panel-header-actions']").exists()).toBe(false);
  });

  it("omits the count when there is none and formats it for the locale otherwise", () => {
    const bare = mountWithI18n(PanelHeader, { props: { title: "Change overview" } });
    expect(bare.find("[data-testid='panel-header-count']").exists()).toBe(false);
    const es = mountWithI18n(
      PanelHeader,
      { props: { title: "Files", count: 48210 } },
      { locale: "es" },
    );
    expect(es.get("[data-testid='panel-header-count']").text()).toBe("48.210");
  });

  it("puts the icon actions at the right end", () => {
    const wrapper = mountWithI18n(PanelHeader, {
      props: { title: "Files", count: 48 },
      slots: {
        actions: () => [
          h(IconButton, { label: "Filter", icon: ListFilter }),
          h(IconButton, { label: "Collapse all", icon: ListFilter }),
        ],
      },
    });
    const actions = wrapper.get("[data-testid='panel-header-actions']");
    expect(actions.classes()).toContain("ml-auto");
    expect(actions.findAll("button").map((b) => b.attributes("aria-label"))).toEqual([
      "Filter",
      "Collapse all",
    ]);
  });
});
