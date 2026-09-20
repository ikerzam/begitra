import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computed, defineComponent, h, nextTick, ref, type PropType } from "vue";

import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { installShortcuts } from "@/shortcuts/useShortcut";

import { nextHunkIndex, previousHunkIndex, useHunkNavigation } from "./useHunkNavigation";

const offsets = [0, 400, 900];

describe("nextHunkIndex", () => {
  it("goes to the first header below the top of the viewport", () => {
    expect(nextHunkIndex(offsets, 0)).toBe(1);
    expect(nextHunkIndex(offsets, 400)).toBe(2);
    expect(nextHunkIndex(offsets, 401)).toBe(2);
  });

  it("treats a header within a pixel of the top as reached", () => {
    expect(nextHunkIndex(offsets, 399.5)).toBe(2);
  });

  it("wraps to the first header after the last one", () => {
    expect(nextHunkIndex(offsets, 900)).toBe(0);
    expect(nextHunkIndex(offsets, 2_000)).toBe(0);
  });

  it("is -1 without headers", () => {
    expect(nextHunkIndex([], 0)).toBe(-1);
  });
});

describe("previousHunkIndex", () => {
  it("goes to the last header above the top of the viewport", () => {
    expect(previousHunkIndex(offsets, 900)).toBe(1);
    expect(previousHunkIndex(offsets, 950)).toBe(2);
    expect(previousHunkIndex(offsets, 402)).toBe(1);
  });

  it("treats a header within a pixel of the top as reached", () => {
    expect(previousHunkIndex(offsets, 400.5)).toBe(0);
  });

  it("wraps to the last header before the first one", () => {
    expect(previousHunkIndex(offsets, 0)).toBe(2);
  });

  it("is -1 without headers", () => {
    expect(previousHunkIndex([], 0)).toBe(-1);
  });
});

describe("useHunkNavigation", () => {
  let uninstall: () => void = () => {};

  beforeEach(() => {
    setShortcutRegistry(new ShortcutRegistry("windows"));
    uninstall = installShortcuts(window);
  });

  afterEach(() => {
    uninstall();
    setShortcutRegistry(undefined);
  });

  /** A body whose header tops are given; the scroll position is a ref the keys move. */
  const Body = defineComponent({
    props: { offsets: { type: Array as PropType<number[]>, required: true } },
    setup(props) {
      const scrollTop = ref(400);
      useHunkNavigation({
        offsets: computed(() => props.offsets),
        scrollTop,
        scrollTo: (top) => {
          scrollTop.value = top;
        },
      });
      return () => h("div", { "data-testid": "body", "data-top": scrollTop.value });
    },
  });

  function mountBody(headers = offsets) {
    const wrapper = mount(Body, { props: { offsets: headers }, attachTo: document.body });
    const top = () => Number(wrapper.get('[data-testid="body"]').attributes("data-top"));
    return { wrapper, top };
  }

  it("scrolls the body to the next and previous headers with n and p", async () => {
    const { wrapper, top } = mountBody();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
    await nextTick();
    expect(top()).toBe(900);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "p" }));
    await nextTick();
    expect(top()).toBe(400);
    wrapper.unmount();
  });

  it("does nothing without headers", async () => {
    const { wrapper, top } = mountBody([]);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "n" }));
    await nextTick();
    expect(top()).toBe(400);
    wrapper.unmount();
  });
});
