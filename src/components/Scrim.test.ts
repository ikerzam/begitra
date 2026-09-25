import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import Scrim from "./Scrim.vue";

describe("Scrim", () => {
  it("covers the window in the shadow colour and centres its panel", () => {
    const wrapper = mountWithI18n(Scrim, {
      slots: { default: "<div data-testid='panel' />" },
    });
    expect(wrapper.classes()).toEqual(
      expect.arrayContaining(["fixed", "inset-0", "bg-shadow", "items-center", "justify-center"]),
    );
    expect(wrapper.find("[data-testid='panel']").exists()).toBe(true);
  });

  it("puts its panel at the top when asked", () => {
    const wrapper = mountWithI18n(Scrim, { props: { align: "top" } });
    expect(wrapper.classes()).toContain("items-start");
    expect(wrapper.classes()).not.toContain("items-center");
  });

  it("dismisses on a press that starts on it, not on one inside the panel nor on a click", async () => {
    const wrapper = mountWithI18n(Scrim, {
      slots: { default: "<input data-testid='panel' />" },
    });
    await wrapper.get("[data-testid='panel']").trigger("pointerdown");
    // A selection dragged from the panel and released outside ends as a click on the scrim.
    await wrapper.trigger("click");
    expect(wrapper.emitted("dismiss")).toBeUndefined();
    await wrapper.trigger("pointerdown");
    expect(wrapper.emitted("dismiss")).toHaveLength(1);
  });

  it("keeps the focus on any press and dismisses on the main button only", () => {
    const wrapper = mountWithI18n(Scrim);
    const press = (button: number) => {
      const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button });
      wrapper.element.dispatchEvent(event);
      return event;
    };
    expect(press(2).defaultPrevented).toBe(true);
    expect(wrapper.emitted("dismiss")).toBeUndefined();
    // A right press opens no menu behind the scrim.
    const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    wrapper.element.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(press(0).defaultPrevented).toBe(true);
    expect(wrapper.emitted("dismiss")).toHaveLength(1);
  });
});
