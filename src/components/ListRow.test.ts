import { GitBranch } from "@lucide/vue";
import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import ListRow from "./ListRow.vue";

describe("ListRow", () => {
  it("renders a branch with its lane dot, name and ahead/behind", () => {
    const wrapper = mountWithI18n(ListRow, {
      props: { name: "feature/tile-cache", lane: 3, ahead: 2, behind: 0 },
    });
    expect(wrapper.attributes("role")).toBe("option");
    expect(wrapper.attributes("aria-selected")).toBe("false");
    expect(wrapper.attributes("tabindex")).toBe("-1");
    expect(wrapper.classes()).toContain("h-row-list");
    expect(wrapper.get("[data-lane]").classes()).toContain("bg-lane-3");
    expect(wrapper.get("[data-testid='list-row-name']").text()).toBe("feature/tile-cache");
    // The whole name is its tooltip, whatever the row cuts.
    expect(wrapper.get("[data-testid='list-row-name']").attributes("data-tooltip")).toBe(
      "feature/tile-cache",
    );
    expect(wrapper.get("[data-testid='ahead']").text()).toBe("2");
    expect(wrapper.find("[data-tooltip='Uncommitted changes']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='list-row-meta']").exists()).toBe(false);
  });

  it("shows the dirty marker before the counts", () => {
    const wrapper = mountWithI18n(ListRow, {
      props: { name: "feature/tile-cache", lane: 3, dirty: true, ahead: 2, behind: 0 },
    });
    const dirty = wrapper.get("[data-tooltip='Uncommitted changes']");
    expect(dirty.classes()).toContain("bg-warn");
    const html = wrapper.html();
    expect(html.indexOf("Uncommitted changes")).toBeLessThan(html.indexOf('data-testid="ahead"'));
  });

  it("renders a sidebar item with an icon and a count, bold and white when selected", () => {
    const wrapper = mountWithI18n(ListRow, {
      props: { name: "Branches", icon: GitBranch, meta: "6", selected: true },
    });
    expect(wrapper.get("svg").classes()).toContain("text-fg");
    expect(wrapper.get("[data-testid='list-row-name']").classes()).toContain("font-medium");
    expect(wrapper.get("[data-testid='list-row-meta']").text()).toBe("6");
    expect(wrapper.get("[data-testid='list-row-meta']").classes()).toContain("text-fg-muted");
    expect(wrapper.find("[data-testid='ahead']").exists()).toBe(false);
    expect(wrapper.classes()).toContain("border-accent");
    expect(wrapper.classes()).toContain("bg-selected");
    expect(wrapper.attributes("aria-selected")).toBe("true");
    expect(wrapper.attributes("tabindex")).toBe("0");

    const idle = mountWithI18n(ListRow, { props: { name: "Repos", icon: GitBranch, meta: "14" } });
    expect(idle.get("svg").classes()).toContain("text-fg-secondary");
    expect(idle.classes()).toContain("hover:bg-hover");
  });

  it("colours its icon by a lane, and carries its markers' tooltips and description", () => {
    const wrapper = mountWithI18n(ListRow, {
      props: {
        name: "claude/fix-auth",
        lane: 4,
        icon: GitBranch,
        iconBeside: true,
        iconLane: 4,
        iconTooltip: "Checked out in claude-auth",
        meta: "gone",
        metaTooltip: "origin/claude/fix-auth is gone from its remote",
        description: "Checked out in claude-auth",
      },
    });
    const icon = wrapper.get("[data-testid='list-row-icon']");
    expect(icon.classes()).toContain("text-lane-4");
    expect(icon.classes()).not.toContain("text-fg-secondary");
    expect(icon.attributes("data-tooltip")).toBe("Checked out in claude-auth");
    const meta = wrapper.get("[data-testid='list-row-meta']");
    expect(meta.attributes("data-tooltip")).toBe("origin/claude/fix-auth is gone from its remote");
    expect(wrapper.attributes("aria-description")).toBe("Checked out in claude-auth");
    // Without them nothing is added.
    const plain = mountWithI18n(ListRow, { props: { name: "main", lane: 1 } });
    expect(plain.attributes("aria-description")).toBeUndefined();
    expect(plain.find("[data-testid='list-row-icon']").exists()).toBe(false);
  });

  it("selects on click and activates on Enter or double click", async () => {
    const wrapper = mountWithI18n(ListRow, { props: { name: "main" } });
    await wrapper.trigger("click");
    expect(wrapper.emitted("select")).toHaveLength(1);
    await wrapper.trigger("keydown", { key: "Enter" });
    await wrapper.trigger("dblclick");
    expect(wrapper.emitted("activate")).toHaveLength(2);
  });
});
