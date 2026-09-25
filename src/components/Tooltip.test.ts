import { afterEach, describe, expect, it, vi } from "vitest";

import { mountWithI18n } from "@/test/mount";

import Tooltip from "./Tooltip.vue";

function mountTooltip(props: { label: string; keys?: string; placement?: "top" | "bottom" }) {
  return mountWithI18n(Tooltip, {
    props,
    slots: { default: "<button type='button' data-testid='trigger'>r</button>" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Lays the bubble out at `bubble` and every other element at `trigger` (jsdom lays nothing out). */
function layout(bubble: DOMRect, trigger: DOMRect): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute("role") === "tooltip" ? bubble : trigger;
  });
}

describe("Tooltip", () => {
  it("stays hidden until the trigger is hovered, then shows the label and the kbd hint", async () => {
    const wrapper = mountTooltip({ label: "Mark reviewed", keys: "R" });
    expect(wrapper.find("[role='tooltip']").exists()).toBe(false);

    await wrapper.trigger("mouseenter");
    const tooltip = wrapper.get("[role='tooltip']");
    expect(tooltip.text()).toContain("Mark reviewed");
    expect(tooltip.get("kbd").text()).toBe("R");
    expect(tooltip.classes()).toContain("bg-raised");
    expect(tooltip.classes()).toContain("border-line-strong");
    expect(tooltip.classes()).toContain("shadow-overlay");
    expect(tooltip.classes()).toContain("top-full");
    expect(tooltip.classes()).toContain("text-sm");
    expect(tooltip.classes()).toContain("px-2");
    expect(tooltip.classes()).toContain("py-1");

    await wrapper.trigger("mouseleave");
    expect(wrapper.find("[role='tooltip']").exists()).toBe(false);
  });

  it("shows on keyboard focus and closes with Escape", async () => {
    const wrapper = mountTooltip({ label: "Settings" });
    await wrapper.trigger("focusin");
    expect(wrapper.find("[role='tooltip']").exists()).toBe(true);
    expect(wrapper.find("kbd").exists()).toBe(false);

    await wrapper.trigger("keydown", { key: "Escape" });
    expect(wrapper.find("[role='tooltip']").exists()).toBe(false);

    await wrapper.trigger("focusin");
    await wrapper.trigger("focusout");
    expect(wrapper.find("[role='tooltip']").exists()).toBe(false);
  });

  it("can open above the trigger", async () => {
    const wrapper = mountTooltip({ label: "x", placement: "top" });
    await wrapper.trigger("mouseenter");
    expect(wrapper.get("[role='tooltip']").classes()).toContain("bottom-full");
  });

  it("hands the tooltip id to the trigger while open", async () => {
    const wrapper = mountWithI18n(Tooltip, {
      props: { label: "x" },
      slots: {
        default: `<template #default="{ id }"><button type="button" :aria-describedby="id">r</button></template>`,
      },
    });
    expect(wrapper.get("button").attributes("aria-describedby")).toBeUndefined();
    await wrapper.trigger("mouseenter");
    expect(wrapper.get("button").attributes("aria-describedby")).toBe(
      wrapper.get("[role='tooltip']").attributes("id"),
    );
  });

  it("lines up with the trigger's right edge, or opens above it, where it would leave the window", async () => {
    // jsdom's window is 1024 x 768.
    layout(
      DOMRect.fromRect({ x: 990, y: 38, width: 140, height: 28 }),
      DOMRect.fromRect({ x: 990, y: 10, width: 24, height: 24 }),
    );
    const right = mountTooltip({ label: "Changes" });
    await right.trigger("mouseenter");
    await right.vm.$nextTick();
    expect(right.get("[role='tooltip']").classes()).toContain("tooltip-end");
    right.unmount();
    vi.restoreAllMocks();
    layout(
      DOMRect.fromRect({ x: 100, y: 762, width: 140, height: 28 }),
      DOMRect.fromRect({ x: 100, y: 734, width: 24, height: 24 }),
    );
    const low = mountTooltip({ label: "Status" });
    await low.trigger("mouseenter");
    await low.vm.$nextTick();
    expect(low.get("[role='tooltip']").classes()).toContain("bottom-full");
    low.unmount();
  });
});
