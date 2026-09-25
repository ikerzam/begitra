import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import PaneResizer from "./PaneResizer.vue";

describe("PaneResizer", () => {
  it("resizes by dragging and with the arrow keys, and asks for the default on a double click", async () => {
    const wrapper = mountWithI18n(PaneResizer, {
      props: { size: 240, label: "Resize the sidebar", min: 200, max: 420 },
      attachTo: document.body,
    });
    expect(wrapper.attributes("role")).toBe("separator");
    expect(wrapper.attributes("aria-valuenow")).toBe("240");
    await wrapper.trigger("mousedown", { clientX: 100 });
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 180 }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    // Released: a later move no longer resizes.
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 400 }));
    expect(wrapper.emitted("resize")).toEqual([[320]]);
    await wrapper.trigger("keydown", { key: "ArrowRight" });
    expect(wrapper.emitted("resize")?.at(-1)).toEqual([256]);
    await wrapper.trigger("dblclick");
    expect(wrapper.emitted("reset")).toHaveLength(1);
    wrapper.unmount();
  });

  it("grows a pane on the right by dragging left", async () => {
    const wrapper = mountWithI18n(PaneResizer, {
      props: { size: 480, label: "Commit", direction: -1 },
      attachTo: document.body,
    });
    await wrapper.trigger("mousedown", { clientX: 900 });
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 860 }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(wrapper.emitted("resize")).toEqual([[520]]);
    wrapper.unmount();
  });
});
