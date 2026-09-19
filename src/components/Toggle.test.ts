import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import Toggle from "./Toggle.vue";

describe("Toggle", () => {
  it("is a switch button, off by default, in the monochrome treatment", () => {
    const wrapper = mountWithI18n(Toggle, { props: { label: "Side by side" } });
    expect(wrapper.element.tagName).toBe("BUTTON");
    expect(wrapper.attributes("role")).toBe("switch");
    expect(wrapper.attributes("aria-checked")).toBe("false");
    expect(wrapper.attributes("aria-label")).toBe("Side by side");
    expect(wrapper.classes()).toContain("bg-line-strong");
    expect(wrapper.classes()).toContain("justify-start");
    expect(wrapper.classes()).toContain("w-control");
    expect(wrapper.classes()).toContain("h-icon");
    expect(wrapper.get("span").classes()).toContain("bg-fg-secondary");
  });

  it("turns on through v-model with the knob moving to the end", async () => {
    const wrapper = mountWithI18n(Toggle, { props: { label: "x", modelValue: false } });
    await wrapper.trigger("click");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([true]);

    await wrapper.setProps({ modelValue: true });
    expect(wrapper.attributes("aria-checked")).toBe("true");
    expect(wrapper.classes()).toContain("bg-fg");
    expect(wrapper.classes()).toContain("justify-end");
    expect(wrapper.get("span").classes()).toContain("bg-app");

    await wrapper.trigger("click");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([false]);
  });

  it("ignores clicks and dims when disabled", async () => {
    const off = mountWithI18n(Toggle, { props: { label: "x", disabled: true } });
    expect(off.attributes("disabled")).toBeDefined();
    expect(off.classes()).toContain("bg-line");
    expect(off.get("span").classes()).toContain("bg-fg-disabled");
    await off.trigger("click");
    expect(off.emitted("update:modelValue")).toBeUndefined();

    const on = mountWithI18n(Toggle, { props: { label: "x", disabled: true, modelValue: true } });
    expect(on.classes()).toContain("bg-fg-disabled");
    expect(on.get("span").classes()).toContain("bg-app");
  });
});
