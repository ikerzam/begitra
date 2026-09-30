import { afterEach, describe, expect, it, vi } from "vitest";

import { mountWithI18n } from "@/test/mount";

import PathPopover from "./PathPopover.vue";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** Lays the popover out at `popover` and every other element at `button` (jsdom lays nothing out). */
function layout(popover: DOMRect, button: DOMRect): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset["testid"] === "path-popover" ? popover : button;
  });
}

describe("PathPopover", () => {
  it("hangs fixed from its button's left edge, and from its right one where it would leave the window", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    layout(
      DOMRect.fromRect({ x: 0, y: 0, width: 320, height: 80 }),
      DOMRect.fromRect({ x: 100, y: 10, width: 60, height: 24 }),
    );
    const fits = mountWithI18n(PathPopover, { props: { path: "", anchor } });
    await fits.vm.$nextTick();
    // Fixed, 4px under the button, so the filter bar's sideways scroll never cuts it.
    expect(fits.classes()).toContain("fixed");
    expect(fits.attributes("style")).toContain("left: 100px");
    expect(fits.attributes("style")).toContain("top: 38px");
    fits.unmount();
    vi.restoreAllMocks();
    // jsdom's window is 1024 wide: from x 900 the popover would end at 1220.
    layout(
      DOMRect.fromRect({ x: 0, y: 0, width: 320, height: 80 }),
      DOMRect.fromRect({ x: 900, y: 10, width: 110, height: 24 }),
    );
    const turned = mountWithI18n(PathPopover, { props: { path: "", anchor } });
    await turned.vm.$nextTick();
    expect(turned.attributes("style")).toContain("left: 690px");
    turned.unmount();
  });

  it("closes on a scroll outside it", () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const wrapper = mountWithI18n(PathPopover, { props: { path: "", anchor } });
    document.body.dispatchEvent(new Event("scroll"));
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });
});
