import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import RadioGroup from "./RadioGroup.vue";
import type { RadioOption } from "./types";

const options: RadioOption[] = [
  { value: "soft", label: "Soft", hint: "keeps the index" },
  { value: "mixed", label: "Mixed" },
  { value: "hard", label: "Hard", hint: "drops everything" },
];

describe("RadioGroup", () => {
  it("is a named radiogroup of native radios sharing one name, the hint describing its option", () => {
    const wrapper = mount(RadioGroup, {
      props: { options, label: "Reset mode", modelValue: "mixed" },
    });
    const group = wrapper.get('[role="radiogroup"]');
    expect(group.attributes("aria-label")).toBe("Reset mode");
    const inputs = wrapper.findAll<HTMLInputElement>('input[type="radio"]');
    expect(inputs).toHaveLength(3);
    expect(new Set(inputs.map((input) => input.element.name)).size).toBe(1);
    expect(inputs.map((input) => input.element.checked)).toEqual([false, true, false]);
    const soft = inputs[0]!;
    const hintId = soft.attributes("aria-describedby");
    expect(hintId).toBeTruthy();
    expect(wrapper.get(`#${hintId}`).text()).toBe("keeps the index");
    expect(inputs[1]?.attributes("aria-describedby")).toBeUndefined();
    expect(wrapper.get('[data-testid="radio-mixed"]').text()).toBe("Mixed");
  });

  it("updates the model from a choice and disables every input when asked", async () => {
    const wrapper = mount(RadioGroup, {
      props: { options, label: "Reset mode", modelValue: "mixed" },
    });
    await wrapper.get('[data-testid="radio-hard"] input').setValue(true);
    expect(wrapper.emitted("update:modelValue")?.at(-1)).toEqual(["hard"]);
    await wrapper.setProps({ disabled: true });
    for (const input of wrapper.findAll<HTMLInputElement>("input")) {
      expect(input.element.disabled).toBe(true);
    }
    expect(wrapper.get('[data-testid="radio-soft"]').classes()).toContain("text-fg-disabled");
  });
});
