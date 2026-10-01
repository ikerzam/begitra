import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import SidebarSection from "./SidebarSection.vue";

describe("SidebarSection", () => {
  it("names the section and its count in one header button that folds and opens it", async () => {
    const wrapper = mountWithI18n(SidebarSection, {
      props: { heading: "Branches", count: "12", folded: false },
      slots: { default: "<p data-testid='rows'>rows</p>", actions: "<button>sort</button>" },
    });
    const header = wrapper.get('[data-testid="section-header"]');
    expect(header.element.tagName).toBe("BUTTON");
    // A heading holds the button, so a screen reader can jump from section to section.
    expect(header.element.parentElement?.tagName).toBe("H2");
    expect(header.text()).toBe("Branches12");
    expect(header.attributes("aria-expanded")).toBe("true");
    const body = wrapper.get('[data-testid="rows"]').element.parentElement;
    expect(header.attributes("aria-controls")).toBe(body?.id);
    expect(header.find("svg").classes()).toContain("lucide-chevron-down");
    // The actions sit beside the button, not inside it.
    expect(header.find("button").exists()).toBe(false);
    expect(wrapper.text()).toContain("sort");
    await header.trigger("click");
    expect(wrapper.emitted("toggle")).toHaveLength(1);
  });

  it("shows no count while its rows are read, and the alert in place of it when they failed", () => {
    const reading = mountWithI18n(SidebarSection, {
      props: { heading: "Worktrees", count: "", folded: false },
    });
    expect(reading.get('[data-testid="section-header"]').text()).toBe("Worktrees");
    expect(reading.find('[data-testid="section-count"]').exists()).toBe(false);
    const failed = mountWithI18n(SidebarSection, {
      props: {
        heading: "Worktrees",
        count: "",
        folded: true,
        alert: "Couldn't list the worktrees",
      },
    });
    const alert = failed.get('[data-testid="section-alert"]');
    expect(alert.attributes("role")).toBe("img");
    expect(alert.attributes("aria-label")).toBe("Couldn't list the worktrees");
    expect(alert.find("svg").classes()).toContain("lucide-circle-alert");
  });

  it("hides its rows while folded and says so", () => {
    const wrapper = mountWithI18n(SidebarSection, {
      props: { heading: "Tags", count: "3", folded: true },
      slots: { default: "<p data-testid='rows'>rows</p>" },
    });
    const header = wrapper.get('[data-testid="section-header"]');
    expect(header.attributes("aria-expanded")).toBe("false");
    // The rows are not in the page: the button controls nothing until they are.
    expect(header.attributes("aria-controls")).toBeUndefined();
    expect(header.find("svg").classes()).toContain("lucide-chevron-right");
    expect(wrapper.find('[data-testid="rows"]').exists()).toBe(false);
  });
});
