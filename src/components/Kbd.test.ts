import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import Kbd from "./Kbd.vue";

describe("Kbd", () => {
  it("renders the keys in a kbd element with the hover fill and the small type role", () => {
    const wrapper = mountWithI18n(Kbd, { props: { keys: "⌘K" } });
    expect(wrapper.element.tagName).toBe("KBD");
    expect(wrapper.text()).toBe("⌘K");
    expect(wrapper.classes()).toContain("bg-hover");
    expect(wrapper.classes()).toContain("rounded-sm");
    expect(wrapper.classes()).toContain("text-sm");
    expect(wrapper.classes()).toContain("font-ui");
  });

  it("lets slot content replace the keys prop", () => {
    const wrapper = mountWithI18n(Kbd, { props: { keys: "J" }, slots: { default: "Esc" } });
    expect(wrapper.text()).toBe("Esc");
  });
});
