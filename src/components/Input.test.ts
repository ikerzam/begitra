import { Search } from "@lucide/vue";
import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import Input from "./Input.vue";

describe("Input", () => {
  it("renders a 28px text input with the placeholder in muted text", () => {
    const wrapper = mountWithI18n(Input, {
      props: { placeholder: "Search commits, authors, hashes…" },
    });
    const input = wrapper.get("input");
    expect(input.attributes("type")).toBe("text");
    expect(input.attributes("placeholder")).toBe("Search commits, authors, hashes…");
    expect(input.classes()).toContain("h-control");
    expect(input.classes()).toContain("rounded-sm");
    expect(input.classes()).toContain("border-line-strong");
    expect(input.classes()).toContain("placeholder:text-fg-muted");
    expect(input.classes()).toContain("pl-3");
  });

  it("supports v-model", async () => {
    const wrapper = mountWithI18n(Input, { props: { modelValue: "" } });
    await wrapper.get("input").setValue("claude/fix-auth");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["claude/fix-auth"]);
    await wrapper.setProps({ modelValue: "v2.3.1" });
    expect(wrapper.get("input").element.value).toBe("v2.3.1");
  });

  it("makes room for the optional icon", () => {
    const wrapper = mountWithI18n(Input, { props: { icon: Search } });
    expect(wrapper.get("svg").attributes("aria-hidden")).toBe("true");
    expect(wrapper.get("input").classes()).toContain("pl-6");
  });

  it("shows the error state with the message wired through aria", () => {
    const wrapper = mountWithI18n(Input, {
      props: { modelValue: "v2.3.1..", error: "Not a valid ref or range" },
    });
    const input = wrapper.get("input");
    expect(input.attributes("aria-invalid")).toBe("true");
    expect(input.classes()).toContain("border-danger");
    const message = wrapper.get("p");
    expect(message.text()).toBe("Not a valid ref or range");
    expect(message.classes()).toContain("text-danger");
    expect(message.classes()).toContain("text-sm");
    expect(input.attributes("aria-describedby")).toBe(message.attributes("id"));
  });

  it("keeps the description the caller names beside its own error", () => {
    const hinted = mountWithI18n(Input, { attrs: { "aria-describedby": "settings-hint" } });
    expect(hinted.get("input").attributes("aria-describedby")).toBe("settings-hint");
    const failed = mountWithI18n(Input, {
      props: { error: "Not a valid ref or range" },
      attrs: { "aria-describedby": "settings-hint" },
    });
    const errorId = failed.get("p").attributes("id");
    expect(failed.get("input").attributes("aria-describedby")).toBe(`settings-hint ${errorId}`);
  });

  it("disables the field", () => {
    const wrapper = mountWithI18n(Input, { props: { disabled: true } });
    const input = wrapper.get("input");
    expect(input.attributes("disabled")).toBeDefined();
    expect(input.classes()).toContain("disabled:text-fg-disabled");
  });

  it("forwards other attributes to the input element and grows to 32px in dialogs", () => {
    const wrapper = mountWithI18n(Input, {
      props: { size: "lg" },
      attrs: { name: "path", autocomplete: "off" },
    });
    const input = wrapper.get("input");
    expect(input.attributes("name")).toBe("path");
    expect(input.attributes("autocomplete")).toBe("off");
    expect(input.classes()).toContain("h-6");
    expect(wrapper.attributes("name")).toBeUndefined();
  });
});
