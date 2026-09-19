import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import SkeletonRow from "./SkeletonRow.vue";

describe("SkeletonRow", () => {
  it("is a decorative graph-height row with a dot and three lines in the hover wash", () => {
    const wrapper = mountWithI18n(SkeletonRow);
    expect(wrapper.attributes("aria-hidden")).toBe("true");
    expect(wrapper.classes()).toContain("h-row-graph");
    const spans = wrapper.findAll("span");
    expect(spans).toHaveLength(4);
    expect(spans[0]?.classes()).toContain("bg-selected");
    expect(spans[0]?.classes()).toContain("size-2");
    for (const line of spans.slice(1)) {
      expect(line.classes()).toContain("bg-hover");
      expect(line.classes()).toContain("skeleton-line");
      expect(line.classes()).toContain("rounded-full");
    }
  });

  it("varies the line widths with the index so a streaming list is not a grid", () => {
    const first = mountWithI18n(SkeletonRow, { props: { index: 0 } });
    const second = mountWithI18n(SkeletonRow, { props: { index: 1 } });
    const fifth = mountWithI18n(SkeletonRow, { props: { index: 4 } });
    const width = (w: ReturnType<typeof mountWithI18n>) =>
      w.findAll("span")[1]?.attributes("style");
    expect(width(first)).toContain("44%");
    expect(width(second)).toContain("32%");
    expect(width(fifth)).toBe(width(first));
  });

  it("matches list and tree row heights", () => {
    expect(mountWithI18n(SkeletonRow, { props: { height: "list" } }).classes()).toContain(
      "h-row-list",
    );
    expect(mountWithI18n(SkeletonRow, { props: { height: "tree" } }).classes()).toContain(
      "h-row-tree",
    );
  });
});
