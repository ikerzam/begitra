import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import BrandMark from "./BrandMark.vue";

describe("BrandMark", () => {
  it("draws two branches in lane colours and three commits in the text colour, hidden from readers", () => {
    const svg = mount(BrandMark).get('[data-testid="brand-mark"]');
    expect(svg.attributes("aria-hidden")).toBe("true");
    const branches = svg.findAll("path").map((path) => path.classes());
    expect(branches).toEqual([["stroke-lane-3"], ["stroke-lane-2"]]);
    const commits = svg.findAll("circle");
    expect(commits).toHaveLength(3);
    expect(commits.every((commit) => commit.classes().includes("fill-fg"))).toBe(true);
  });
});
