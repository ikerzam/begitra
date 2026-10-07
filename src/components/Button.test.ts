import { GitBranch } from "@lucide/vue";
import { describe, expect, it, vi } from "vitest";

import { mountWithI18n } from "@/test/mount";

import Button from "./Button.vue";

describe("Button", () => {
  it("renders a real button with the label and the secondary variant by default", () => {
    const wrapper = mountWithI18n(Button, { slots: { default: "Add worktree" } });
    const button = wrapper.get("button");
    expect(button.attributes("type")).toBe("button");
    expect(button.text()).toBe("Add worktree");
    expect(button.attributes("data-variant")).toBe("secondary");
    expect(button.classes()).toContain("border-line-strong");
    expect(button.classes()).toContain("h-control");
    expect(button.classes()).toContain("rounded-md");
  });

  it.each([
    ["primary", ["bg-fg", "text-app"]],
    ["secondary", ["border", "border-line-strong", "text-fg"]],
    ["ghost", ["text-fg-secondary"]],
    ["destructive", ["bg-danger", "text-white"]],
  ] as const)("styles the %s variant with tokens only", (variant, classes) => {
    const wrapper = mountWithI18n(Button, { props: { variant }, slots: { default: "x" } });
    for (const cls of classes) expect(wrapper.classes()).toContain(cls);
    expect(wrapper.attributes("data-variant")).toBe(variant);
  });

  it("outlines only the secondary variant", () => {
    for (const variant of ["primary", "ghost", "destructive"] as const) {
      const wrapper = mountWithI18n(Button, { props: { variant }, slots: { default: "x" } });
      expect(wrapper.classes()).not.toContain("border");
    }
  });

  it("uses the 32px height inside dialogs", () => {
    const wrapper = mountWithI18n(Button, { props: { size: "lg" }, slots: { default: "x" } });
    expect(wrapper.classes()).toContain("h-6");
    expect(wrapper.classes()).not.toContain("h-control");
  });

  it("renders an optional 16px icon before the label", () => {
    const wrapper = mountWithI18n(Button, { props: { icon: GitBranch }, slots: { default: "x" } });
    const svg = wrapper.get("svg");
    expect(svg.attributes("width")).toBe("16");
    expect(svg.attributes("stroke-width")).toBe("1.5");
    expect(svg.attributes("aria-hidden")).toBe("true");
    expect(
      mountWithI18n(Button, { slots: { default: "x" } })
        .find("svg")
        .exists(),
    ).toBe(false);
  });

  it("accepts a submit type", () => {
    const wrapper = mountWithI18n(Button, { props: { type: "submit" }, slots: { default: "x" } });
    expect(wrapper.attributes("type")).toBe("submit");
  });

  it("clicks when enabled and swallows clicks when disabled", async () => {
    const onClick = vi.fn();
    const wrapper = mountWithI18n(Button, { attrs: { onClick }, slots: { default: "x" } });
    await wrapper.trigger("click");
    expect(onClick).toHaveBeenCalledTimes(1);

    const disabled = mountWithI18n(Button, {
      props: { disabled: true },
      attrs: { onClick },
      slots: { default: "x" },
    });
    expect(disabled.attributes("disabled")).toBeDefined();
    expect(disabled.classes()).toContain("disabled:text-fg-disabled");
    await disabled.trigger("click");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("stays focusable while unavailable, says why, and does nothing on a press", async () => {
    const onClick = vi.fn();
    const reason = "main is level with origin/main: nothing to push.";
    const wrapper = mountWithI18n(Button, {
      props: { unavailable: reason, tooltip: "Push main to origin/main" },
      attrs: { onClick },
      slots: { default: "Push" },
    });
    expect(wrapper.attributes("disabled")).toBeUndefined();
    expect(wrapper.attributes("aria-disabled")).toBe("true");
    expect(wrapper.attributes("data-tooltip")).toBe(reason);
    expect(wrapper.attributes("aria-description")).toBe(reason);
    expect(wrapper.classes()).toContain("text-fg-disabled");
    expect(wrapper.classes()).not.toContain("border-line-strong");
    await wrapper.trigger("click");
    expect(onClick).not.toHaveBeenCalled();
    // Available again, the tooltip and the key hint are its own.
    await wrapper.setProps({ unavailable: "", keys: "Ctrl Shift P" });
    expect(wrapper.attributes("aria-disabled")).toBeUndefined();
    expect(wrapper.attributes("data-tooltip")).toBe("Push main to origin/main");
    expect(wrapper.attributes("data-tooltip-keys")).toBe("Ctrl Shift P");
    await wrapper.trigger("click");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps a submit from its form while unavailable", () => {
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    const form = document.createElement("form");
    form.addEventListener("submit", onSubmit);
    document.body.appendChild(form);
    const wrapper = mountWithI18n(Button, {
      props: { type: "submit", unavailable: "Not now." },
      slots: { default: "Commit" },
      attachTo: form,
    });
    (wrapper.element as HTMLButtonElement).click();
    expect(onSubmit).not.toHaveBeenCalled();
    wrapper.unmount();
    form.remove();
  });
});
