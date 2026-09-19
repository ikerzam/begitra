import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import LaneDot from "./LaneDot.vue";
import { laneBgClass, laneIndex, laneTextClass } from "./lanes";

describe("LaneDot", () => {
  it("is an 8px decorative dot in the lane colour", () => {
    const wrapper = mountWithI18n(LaneDot, { props: { lane: 3 } });
    expect(wrapper.attributes("aria-hidden")).toBe("true");
    expect(wrapper.classes()).toContain("size-2");
    expect(wrapper.classes()).toContain("rounded-full");
    expect(wrapper.classes()).toContain("bg-lane-3");
    expect(wrapper.attributes("data-lane")).toBe("3");
  });

  it("cycles after eight lanes and never drops below lane 1", () => {
    expect(mountWithI18n(LaneDot, { props: { lane: 9 } }).classes()).toContain("bg-lane-1");
    expect(mountWithI18n(LaneDot, { props: { lane: 16 } }).classes()).toContain("bg-lane-8");
    expect(mountWithI18n(LaneDot, { props: { lane: 0 } }).classes()).toContain("bg-lane-1");
    expect(mountWithI18n(LaneDot).classes()).toContain("bg-lane-1");
  });
});

describe("lane classes", () => {
  it("map lane numbers onto the eight token utilities", () => {
    expect(laneIndex(1)).toBe(1);
    expect(laneIndex(8)).toBe(8);
    expect(laneIndex(17)).toBe(1);
    expect(laneIndex(-4)).toBe(1);
    expect(laneIndex(Number.NaN)).toBe(1);
    expect(laneBgClass(5)).toBe("bg-lane-5");
    expect(laneTextClass(12)).toBe("text-lane-4");
  });
});
