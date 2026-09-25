import { afterEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import { mountWithI18n } from "@/test/mount";
import { chooseOption, optionLabels, shownLabel } from "@/test/select";

import Select from "./Select.vue";

const options = [
  { value: "all", label: "All branches" },
  { value: "current", label: "Current branch" },
  { value: "none", label: "Nothing", disabled: true },
  { value: "claude", label: "claude/fix-auth" },
];

afterEach(() => {
  document.body.innerHTML = "";
});

function mountSelect(extra: Record<string, unknown> = {}) {
  return mountWithI18n(Select, {
    props: { options, modelValue: "all", label: "Scope", ...extra },
    attachTo: document.body,
  });
}

describe("Select", () => {
  it("is a combobox button with the value and a chevron, closed until opened", async () => {
    const wrapper = mountSelect();
    const button = wrapper.get('[data-testid="select-button"]');
    expect(button.attributes("role")).toBe("combobox");
    expect(button.attributes("aria-haspopup")).toBe("listbox");
    expect(button.attributes("aria-expanded")).toBe("false");
    expect(button.attributes("aria-label")).toBe("Scope");
    expect(button.classes()).toEqual(
      expect.arrayContaining(["h-control", "border-line-strong", "bg-app"]),
    );
    expect(shownLabel(wrapper)).toBe("All branches");
    expect(wrapper.find('[data-testid="option-list"]').exists()).toBe(false);
    expect(wrapper.get("svg").attributes("aria-hidden")).toBe("true");
    expect(await optionLabels(wrapper)).toEqual([
      "All branches",
      "Current branch",
      "Nothing",
      "claude/fix-auth",
    ]);
    wrapper.unmount();
  });

  it("opens in the overlay treatment with the selected option checked, and chooses by click", async () => {
    const wrapper = mountSelect();
    await wrapper.get('[data-testid="select-button"]').trigger("click");
    const list = wrapper.get('[data-testid="option-list"]');
    expect(list.attributes("role")).toBe("listbox");
    expect(list.classes()).toEqual(
      expect.arrayContaining(["fixed", "bg-raised", "border-line-strong", "shadow-overlay"]),
    );
    const [all, , nothing] = wrapper.findAll('[data-testid="option"]');
    expect(all?.attributes("aria-selected")).toBe("true");
    expect(all?.find("svg").exists()).toBe(true);
    expect(nothing?.attributes("aria-disabled")).toBe("true");
    const button = wrapper.get('[data-testid="select-button"]');
    expect(button.attributes("aria-expanded")).toBe("true");
    expect(button.classes()).toContain("select-open");
    await nothing?.trigger("click");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
    await wrapper.get('[data-testid="option"][data-value="current"]').trigger("click");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["current"]);
    expect(wrapper.find('[data-testid="option-list"]').exists()).toBe(false);
    // The helper the callers' tests use opens a closed select and clicks the option.
    await chooseOption(wrapper, "claude");
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["claude"]);
    wrapper.unmount();
  });

  it("walks the options with the keys, skips disabled ones, jumps by letter and stops its keys", async () => {
    const wrapper = mountSelect();
    const button = wrapper.get('[data-testid="select-button"]');
    const outside: string[] = [];
    wrapper.element.parentElement?.addEventListener("keydown", (event: KeyboardEvent) =>
      outside.push(event.key),
    );
    // A letter on a closed select is left to the page (j and k walk the settings).
    await button.trigger("keydown", { key: "j" });
    expect(wrapper.find('[data-testid="option-list"]').exists()).toBe(false);
    await button.trigger("keydown", { key: "ArrowDown" });
    expect(button.attributes("aria-activedescendant")).toMatch(/-0$/);
    await button.trigger("keydown", { key: "ArrowDown" });
    await button.trigger("keydown", { key: "ArrowDown" });
    // "Nothing" is disabled: the second Down lands on claude/fix-auth.
    expect(button.attributes("aria-activedescendant")).toMatch(/-3$/);
    await button.trigger("keydown", { key: "Home" });
    expect(button.attributes("aria-activedescendant")).toMatch(/-0$/);
    await button.trigger("keydown", { key: "c" });
    expect(button.attributes("aria-activedescendant")).toMatch(/-1$/);
    await button.trigger("keydown", { key: "c" });
    expect(button.attributes("aria-activedescendant")).toMatch(/-3$/);
    await button.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["claude"]);
    // Escape closes an open list without choosing, and goes no further.
    await button.trigger("keydown", { key: "ArrowUp" });
    await button.trigger("keydown", { key: "Escape" });
    await nextTick();
    expect(wrapper.find('[data-testid="option-list"]').exists()).toBe(false);
    expect(wrapper.emitted("update:modelValue")).toHaveLength(1);
    // The closed select's keys reach the page; the open list's stop at the select.
    expect(outside).toEqual(["j", "ArrowDown", "ArrowUp"]);
    wrapper.unmount();
  });

  it("closes on a press outside and chooses with Tab", async () => {
    const wrapper = mountSelect();
    const button = wrapper.get('[data-testid="select-button"]');
    await button.trigger("click");
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await nextTick();
    expect(wrapper.find('[data-testid="option-list"]').exists()).toBe(false);
    await button.trigger("keydown", { key: "ArrowDown" });
    await button.trigger("keydown", { key: "ArrowDown" });
    await button.trigger("keydown", { key: "Tab" });
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["current"]);
    wrapper.unmount();
  });

  it("does nothing while disabled and dims the chevron", async () => {
    const wrapper = mountSelect({ disabled: true });
    const button = wrapper.get('[data-testid="select-button"]');
    expect(button.attributes("disabled")).toBeDefined();
    await button.trigger("keydown", { key: "ArrowDown" });
    expect(wrapper.find('[data-testid="option-list"]').exists()).toBe(false);
    expect(wrapper.get("svg").classes()).toContain("text-fg-disabled");
    wrapper.unmount();
  });
});
