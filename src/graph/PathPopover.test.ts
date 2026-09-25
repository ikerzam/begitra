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
  it("hangs from its button's left edge, and from its right one where it would leave the window", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    layout(
      DOMRect.fromRect({ x: 100, y: 40, width: 320, height: 80 }),
      DOMRect.fromRect({ x: 100, y: 10, width: 60, height: 24 }),
    );
    const fits = mountWithI18n(PathPopover, { props: { path: "", anchor } });
    expect(fits.classes()).toContain("left-0");
    fits.unmount();
    vi.restoreAllMocks();
    // jsdom's window is 1024 wide: from x 900 the popover would end at 1220.
    layout(
      DOMRect.fromRect({ x: 900, y: 40, width: 320, height: 80 }),
      DOMRect.fromRect({ x: 900, y: 10, width: 110, height: 24 }),
    );
    const turned = mountWithI18n(PathPopover, { props: { path: "", anchor } });
    await turned.vm.$nextTick();
    expect(turned.classes()).toContain("right-0");
    expect(turned.classes()).not.toContain("left-0");
    turned.unmount();
  });
});
