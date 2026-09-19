import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import Checkbox from "./Checkbox.vue";

describe("Checkbox", () => {
  it("renders a native checkbox inside a label with a 16px monochrome box", () => {
    const wrapper = mountWithI18n(Checkbox, { props: { label: "Hide generated" } });
    expect(wrapper.element.tagName).toBe("LABEL");
    expect(wrapper.text()).toBe("Hide generated");
    const input = wrapper.get("input");
    expect(input.attributes("type")).toBe("checkbox");
    expect(input.classes()).toContain("sr-only");
    const box = wrapper.get("span[aria-hidden]");
    expect(box.classes()).toContain("size-icon");
    expect(box.classes()).toContain("rounded-sm");
    expect(box.classes()).toContain("border-line-strong");
    expect(wrapper.find("svg").exists()).toBe(false);
  });

  it("toggles through v-model and fills the box when checked", async () => {
    const wrapper = mountWithI18n(Checkbox, { props: { label: "x", modelValue: false } });
    await wrapper.get("input").setValue(true);
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual([true]);

    await wrapper.setProps({ modelValue: true });
    const box = wrapper.get("span[aria-hidden]");
    expect(box.classes()).toContain("bg-fg");
    expect(box.classes()).toContain("text-app");
    expect(wrapper.get("svg").classes()).toContain("lucide-check");
  });

  it("shows the indeterminate state as a minus and exposes it to assistive technology", () => {
    const wrapper = mountWithI18n(Checkbox, {
      props: { label: "Hide lockfiles", indeterminate: true },
    });
    const input = wrapper.get("input");
    expect(input.element.indeterminate).toBe(true);
    expect(input.attributes("aria-checked")).toBe("mixed");
    expect(wrapper.get("svg").classes()).toContain("lucide-minus");
    expect(wrapper.get("span[aria-hidden]").classes()).toContain("bg-fg");
  });

  it("dims the label and the box when disabled", () => {
    const wrapper = mountWithI18n(Checkbox, { props: { label: "Hide tests", disabled: true } });
    expect(wrapper.get("input").attributes("disabled")).toBeDefined();
    expect(wrapper.classes()).toContain("text-fg-disabled");
    expect(wrapper.get("span[aria-hidden]").classes()).toContain("border-line");
  });

  it("accepts the label as slot content", () => {
    const wrapper = mountWithI18n(Checkbox, { slots: { default: "Slot label" } });
    expect(wrapper.text()).toBe("Slot label");
  });
});
