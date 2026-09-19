import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import Select from "./Select.vue";

const options = [
  { value: "all", label: "All branches" },
  { value: "current", label: "Current branch" },
  { value: "none", label: "Nothing", disabled: true },
];

describe("Select", () => {
  it("renders a native select with the options and a chevron", () => {
    const wrapper = mountWithI18n(Select, {
      props: { options, modelValue: "all", label: "Scope" },
    });
    const select = wrapper.get("select");
    expect(select.attributes("aria-label")).toBe("Scope");
    expect(select.classes()).toContain("h-control");
    expect(select.classes()).toContain("border-line-strong");
    expect(select.classes()).toContain("appearance-none");
    expect(wrapper.findAll("option").map((o) => o.text())).toEqual([
      "All branches",
      "Current branch",
      "Nothing",
    ]);
    expect(wrapper.findAll("option")[2]?.attributes("disabled")).toBeDefined();
    expect(wrapper.get("svg").attributes("aria-hidden")).toBe("true");
  });

  it("supports v-model", async () => {
    const wrapper = mountWithI18n(Select, { props: { options, modelValue: "all" } });
    await wrapper.get("select").setValue("current");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["current"]);
  });

  it("disables the control and dims the chevron", () => {
    const wrapper = mountWithI18n(Select, { props: { options, disabled: true } });
    expect(wrapper.get("select").attributes("disabled")).toBeDefined();
    expect(wrapper.get("svg").classes()).toContain("text-fg-disabled");
  });
});
