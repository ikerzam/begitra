import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import { mountWithI18n } from "@/test/mount";

import OptionList from "./OptionList.vue";

const options = [
  { value: "80", label: "80%" },
  { value: "100", label: "100%" },
  { value: "125", label: "125%", disabled: true },
];

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** Lays the list out at `list` and its anchor at `anchor` (jsdom lays nothing out). */
function layout(anchor: DOMRect, list: DOMRect): HTMLElement {
  const element = document.createElement("button");
  document.body.append(element);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this === element ? anchor : list;
  });
  return element;
}

describe("OptionList", () => {
  it("hangs under its anchor at its width, and above it where the room under it is short", async () => {
    // jsdom's window is 1024 x 768.
    const anchor = layout(
      DOMRect.fromRect({ x: 100, y: 100, width: 96, height: 28 }),
      DOMRect.fromRect({ x: 0, y: 0, width: 96, height: 120 }),
    );
    const under = mountWithI18n(OptionList, {
      props: { id: "zoom", options, anchor, active: 1, selected: "100" },
      attachTo: document.body,
    });
    await nextTick();
    expect(under.attributes("style")).toContain("top: 132px");
    expect(under.attributes("style")).toContain("min-width: 96px");
    const rows = under.findAll('[role="option"]');
    expect(rows[1]?.classes()).toContain("bg-selected");
    expect(rows[1]?.attributes("aria-selected")).toBe("true");
    expect(rows[2]?.attributes("aria-disabled")).toBe("true");
    under.unmount();
    vi.restoreAllMocks();
    const low = layout(
      DOMRect.fromRect({ x: 100, y: 700, width: 96, height: 28 }),
      DOMRect.fromRect({ x: 0, y: 0, width: 96, height: 120 }),
    );
    const above = mountWithI18n(OptionList, {
      props: { id: "zoom", options, anchor: low, active: 0 },
      attachTo: document.body,
    });
    await nextTick();
    expect(above.attributes("style")).toContain("top: 576px");
    above.unmount();
  });

  it("chooses an enabled row on a click and closes on a scroll outside it or a resize", async () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const wrapper = mountWithI18n(OptionList, {
      props: { id: "zoom", options, anchor, active: 0 },
      attachTo: document.body,
    });
    const rows = wrapper.findAll('[role="option"]');
    await rows[2]?.trigger("click");
    expect(wrapper.emitted("choose")).toBeUndefined();
    await rows[1]?.trigger("click");
    expect(wrapper.emitted("choose")).toEqual([[1]]);
    wrapper.element.dispatchEvent(new Event("scroll"));
    expect(wrapper.emitted("close")).toBeUndefined();
    document.body.dispatchEvent(new Event("scroll"));
    expect(wrapper.emitted("close")).toHaveLength(1);
    window.dispatchEvent(new Event("resize"));
    expect(wrapper.emitted("close")).toHaveLength(2);
    wrapper.unmount();
  });
});
