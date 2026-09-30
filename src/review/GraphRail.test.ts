import { describe, expect, it } from "vitest";

import GraphCanvas from "@/graph/GraphCanvas.vue";
import { ROW_HEIGHT } from "@/graph/useGraphGeometry";
import { fakeCommit } from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import GraphRail from "./GraphRail.vue";

describe("GraphRail", () => {
  it("draws the whole list through its window, so lines run to the rail's edges", () => {
    const commits = Array.from({ length: 60 }, (_, n) => fakeCommit(n));
    const wrapper = mountWithI18n(GraphRail, { props: { commits, selectedIndex: 30 } });
    const canvas = wrapper.getComponent(GraphCanvas);
    // Fourteen rows each side of the selected one; the rows after the window give the lines
    // that leave its last row.
    expect(canvas.props("commits")).toHaveLength(60);
    expect(canvas.props("start")).toBe(16);
    expect(canvas.props("end")).toBe(45);
    expect(canvas.props("scrollTop")).toBe(16 * ROW_HEIGHT);
    expect(wrapper.findAll("button")).toHaveLength(29);
  });

  it("keeps the ring on the last drawn lane when the selected commit lies past it", () => {
    const commits = Array.from({ length: 5 }, (_, n) => ({
      ...fakeCommit(n),
      lane: n === 2 ? 4 : 0,
    }));
    const wrapper = mountWithI18n(GraphRail, { props: { commits, selectedIndex: 2 } });
    const style = wrapper.get(".graph-rail-ring").attributes("style") ?? "";
    // Lane 2, the last of the rail's three, sits at 10 + 2 × 12.
    expect(style).toContain("left: 34px");
    expect(style).toContain(`top: ${2 * ROW_HEIGHT + ROW_HEIGHT / 2}px`);
  });
});
