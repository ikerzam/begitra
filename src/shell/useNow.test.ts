import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";

import { useNow } from "./useNow";

const Clock = defineComponent({
  setup() {
    const now = useNow(1_000);
    return () => h("span", String(now.value));
  },
});

describe("useNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes on the interval and stops when unmounted", async () => {
    const wrapper = mount(Clock);
    const first = Number(wrapper.text());
    await vi.advanceTimersByTimeAsync(2_500);
    expect(Number(wrapper.text())).toBe(first + 2_000);
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
