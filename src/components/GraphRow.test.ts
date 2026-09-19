import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import GraphRow from "./GraphRow.vue";

const commit = {
  message: "feat(map): stream tiles through a worker",
  author: "claude",
  date: "2h ago",
  hash: "a1b2c3d",
};

describe("GraphRow", () => {
  it("renders message, author, date and hash with their type roles", () => {
    const wrapper = mountWithI18n(GraphRow, { props: commit });
    expect(wrapper.attributes("role")).toBe("option");
    expect(wrapper.attributes("aria-selected")).toBe("false");
    expect(wrapper.attributes("tabindex")).toBe("-1");
    expect(wrapper.classes()).toContain("h-row-graph");
    expect(wrapper.classes()).toContain("hover:bg-hover");
    expect(wrapper.classes()).toContain("pl-3");
    expect(wrapper.get("[data-testid='graph-row-message']").text()).toBe(commit.message);
    expect(wrapper.get("[data-testid='graph-row-message']").classes()).toContain("truncate");
    expect(wrapper.get("[data-testid='graph-row-author']").classes()).toContain(
      "text-fg-secondary",
    );
    expect(wrapper.get("[data-testid='graph-row-date']").classes()).toContain("text-fg-muted");
    expect(wrapper.get("[data-testid='graph-row-author']").classes()).toContain("text-sm");
    expect(wrapper.get("[data-testid='graph-row-date']").classes()).toContain("text-sm");
    const hash = wrapper.get("[data-testid='graph-row-hash']");
    expect(hash.text()).toBe("a1b2c3d");
    expect(hash.classes()).toContain("font-mono");
    expect(hash.classes()).toContain("text-mono-sm");
  });

  it("marks the selected row with the accent bar and the selected wash", () => {
    const wrapper = mountWithI18n(GraphRow, { props: { ...commit, selected: true } });
    expect(wrapper.attributes("aria-selected")).toBe("true");
    expect(wrapper.attributes("tabindex")).toBe("0");
    expect(wrapper.classes()).toContain("border-accent");
    expect(wrapper.classes()).toContain("bg-selected");
    expect(wrapper.classes()).not.toContain("hover:bg-hover");
  });

  it("places lanes and refs before the message", () => {
    const wrapper = mountWithI18n(GraphRow, {
      props: commit,
      slots: {
        lanes: "<svg data-testid='lanes' />",
        refs: "<span data-testid='badge'>main</span>",
      },
    });
    expect(wrapper.find("[data-testid='graph-row-lanes'] [data-testid='lanes']").exists()).toBe(
      true,
    );
    expect(wrapper.get("[data-testid='graph-row-refs'] [data-testid='badge']").text()).toBe("main");
    expect(wrapper.classes()).not.toContain("pl-3");
    expect(
      mountWithI18n(GraphRow, { props: commit }).find("[data-testid='graph-row-refs']").exists(),
    ).toBe(false);
  });

  it("selects on click and activates on double click or Enter", async () => {
    const wrapper = mountWithI18n(GraphRow, { props: commit });
    await wrapper.trigger("click");
    expect(wrapper.emitted("select")).toHaveLength(1);
    await wrapper.trigger("dblclick");
    expect(wrapper.emitted("activate")).toHaveLength(1);
    await wrapper.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("activate")).toHaveLength(2);
    await wrapper.trigger("keydown", { key: "j" });
    expect(wrapper.emitted("activate")).toHaveLength(2);
  });
});
