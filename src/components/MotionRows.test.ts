import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick, ref, TransitionGroup } from "vue";

import { arm, MOTION_MAX_ROWS } from "@/motion/motion";

import MotionRows from "./MotionRows.vue";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A list of `rows` keyed rows inside MotionRows, as a list component renders it. */
function host(rows: ReturnType<typeof ref<string[]>>) {
  return defineComponent({
    setup() {
      return () =>
        h(
          MotionRows,
          { list: "changes", count: rows.value?.length ?? 0, role: "tree", "data-testid": "rows" },
          () => (rows.value ?? []).map((row) => h("div", { key: row, class: "row" }, row)),
        );
    },
  });
}

describe("MotionRows", () => {
  it("measures a short list through a TransitionGroup and passes its attributes on", () => {
    const rows = ref(["a", "b"]);
    const wrapper = mount(host(rows), {
      global: { stubs: { "transition-group": false } },
    });
    expect(wrapper.findComponent(TransitionGroup).exists()).toBe(true);
    const root = wrapper.get('[data-testid="rows"]');
    expect(root.element.tagName).toBe("DIV");
    expect(root.attributes("role")).toBe("tree");
    expect(root.findAll(".row")).toHaveLength(2);
  });

  it("renders a list past the cap as a plain element", () => {
    const rows = ref(Array.from({ length: MOTION_MAX_ROWS + 1 }, (_, i) => `f${i}`));
    const wrapper = mount(host(rows), {
      global: { stubs: { "transition-group": false } },
    });
    expect(wrapper.findComponent(TransitionGroup).exists()).toBe(false);
    expect(wrapper.get('[data-testid="rows"]').findAll(".row")).toHaveLength(MOTION_MAX_ROWS + 1);
  });

  it("changes at once when nobody armed the list", async () => {
    const rows = ref(["a", "b", "c"]);
    const wrapper = mount(host(rows), {
      global: { stubs: { "transition-group": false } },
    });
    rows.value = ["a", "c"];
    await nextTick();
    expect(wrapper.findAll(".row").map((row) => row.text())).toEqual(["a", "c"]);
  });

  it("turns a leaving row inert while an armed change removes it", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    );
    const rows = ref(["a", "b", "c"]);
    const wrapper = mount(host(rows), {
      global: { stubs: { "transition-group": false } },
      attachTo: document.body,
    });
    const leaving = wrapper.findAll(".row")[1]!.element;
    arm("changes");
    rows.value = ["a", "c"];
    await nextTick();
    expect(leaving.hasAttribute("inert")).toBe(true);
    expect(leaving.getAttribute("aria-hidden")).toBe("true");
    wrapper.unmount();
    vi.unstubAllGlobals();
  });
});
