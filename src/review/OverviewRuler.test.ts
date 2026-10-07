import { mount, type VueWrapper } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { nextTick } from "vue";

import OverviewRuler from "./OverviewRuler.vue";
import type { RulerTick } from "./ruler";

const TICKS: RulerTick[] = [
  { kind: "removed", top: 10, height: 2 },
  { kind: "added", top: 10, height: 6 },
  { kind: "match", top: 40, height: 2 },
  { kind: "current", top: 80, height: 4 },
];

/** A ruler 400px tall over `total` px of rows scrolled to `scrollTop`, its top at 0. */
function ruler(scrollTop = 0, total = 4000) {
  const wrapper = mount(OverviewRuler, {
    props: { ticks: TICKS, total, height: 400, scrollTop },
    attachTo: document.body,
  });
  wrapper.element.getBoundingClientRect = () => new DOMRect(0, 0, 12, 400);
  return wrapper;
}

/** A pointer event: jsdom has no `PointerEvent`, so a mouse event carrying a `pointerId`. */
async function pointer(
  wrapper: VueWrapper,
  type: "pointerdown" | "pointermove" | "pointerup",
  init: { clientY?: number; button?: number },
): Promise<MouseEvent> {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
  Object.defineProperty(event, "pointerId", { value: 1 });
  wrapper.element.dispatchEvent(event);
  await nextTick();
  return event;
}

describe("OverviewRuler", () => {
  it("draws each tick in its lane at its place, hidden from assistive technology", () => {
    const wrapper = ruler();
    expect(wrapper.attributes("aria-hidden")).toBe("true");
    expect(wrapper.attributes("tabindex")).toBeUndefined();
    const ticks = wrapper.findAll("[data-kind]");
    expect(ticks.map((tick) => tick.attributes("data-kind"))).toEqual([
      "removed",
      "added",
      "match",
      "current",
    ]);
    expect(ticks[0]?.classes()).toEqual(expect.arrayContaining(["left-0", "w-1/2", "bg-del"]));
    expect(ticks[1]?.classes()).toEqual(expect.arrayContaining(["right-0", "w-1/2", "bg-add"]));
    expect(ticks[2]?.classes()).toEqual(expect.arrayContaining(["left-1/4", "w-1/2", "bg-warn"]));
    expect(ticks[3]?.classes()).toEqual(expect.arrayContaining(["inset-x-0", "bg-warn"]));
    expect(ticks[1]?.attributes("style")).toContain("top: 10px");
    expect(ticks[1]?.attributes("style")).toContain("height: 6px");
    wrapper.unmount();
  });

  it("shows the view as a slider only while the rows scroll", () => {
    const fits = ruler(0, 300);
    expect(fits.find("[data-testid='overview-ruler-slider']").exists()).toBe(false);
    fits.unmount();

    const wrapper = ruler(1800);
    const slider = wrapper.get("[data-testid='overview-ruler-slider']");
    // 400px of 4,000: a 40px slider, halfway down its 360px of travel.
    expect(slider.attributes("style")).toContain("top: 180px");
    expect(slider.attributes("style")).toContain("height: 40px");
    wrapper.unmount();
  });

  it("brings a clicked place to the middle of the view", async () => {
    const wrapper = ruler();
    await pointer(wrapper, "pointerdown", { button: 0, clientY: 200 });
    expect(wrapper.emitted("scrollTo")).toEqual([[1800]]);
    wrapper.unmount();
  });

  it("does nothing for a click when the rows fit, or for another button", async () => {
    const fits = ruler(0, 300);
    // The press is still the ruler's: the focus stays on the rows.
    const press = await pointer(fits, "pointerdown", { button: 0, clientY: 200 });
    expect(press.defaultPrevented).toBe(true);
    const scrolled = ruler();
    await pointer(scrolled, "pointerdown", { button: 2, clientY: 200 });
    expect(fits.emitted("scrollTo")).toBeUndefined();
    expect(scrolled.emitted("scrollTo")).toBeUndefined();
    fits.unmount();
    scrolled.unmount();
  });

  it("scrolls the rows as the slider is dragged, and stops when it is let go", async () => {
    const wrapper = ruler();
    // The slider spans 0 to 40px: a press on it does not jump.
    await pointer(wrapper, "pointerdown", { button: 0, clientY: 20 });
    expect(wrapper.emitted("scrollTo")).toBeUndefined();
    await pointer(wrapper, "pointermove", { clientY: 56 });
    // 36px of the slider's 360px of travel: a tenth of the 3,600px the rows scroll.
    expect(wrapper.emitted("scrollTo")).toEqual([[360]]);
    expect(wrapper.get("[data-testid='overview-ruler-slider']").classes()).toContain("bg-fg-muted");
    await pointer(wrapper, "pointerup", {});
    await pointer(wrapper, "pointermove", { clientY: 300 });
    expect(wrapper.emitted("scrollTo")).toHaveLength(1);
    expect(wrapper.get("[data-testid='overview-ruler-slider']").classes()).toContain(
      "bg-line-strong",
    );
    wrapper.unmount();
  });

  it("keeps dragging from where a click on the track put the view", async () => {
    const wrapper = ruler();
    await pointer(wrapper, "pointerdown", { button: 0, clientY: 200 });
    await pointer(wrapper, "pointermove", { clientY: 236 });
    expect(wrapper.emitted("scrollTo")).toEqual([[1800], [2160]]);
    wrapper.unmount();
  });

  it("scrolls the rows by the wheel, in pixels or in the diff's lines", async () => {
    const wrapper = ruler();
    await wrapper.trigger("wheel", { deltaY: 120, deltaMode: 0 });
    await wrapper.trigger("wheel", { deltaY: 3, deltaMode: 1 });
    expect(wrapper.emitted("scrollBy")).toEqual([[120], [60]]);
    wrapper.unmount();
  });
});
