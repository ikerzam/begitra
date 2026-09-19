import { Settings } from "@lucide/vue";
import { describe, expect, it, vi } from "vitest";

import { mountWithI18n } from "@/test/mount";

import IconButton from "./IconButton.vue";

describe("IconButton", () => {
  it("is a 28px square button named by its label", () => {
    const wrapper = mountWithI18n(IconButton, { props: { label: "Settings", icon: Settings } });
    expect(wrapper.element.tagName).toBe("BUTTON");
    expect(wrapper.attributes("type")).toBe("button");
    expect(wrapper.attributes("aria-label")).toBe("Settings");
    expect(wrapper.attributes("title")).toBe("Settings");
    expect(wrapper.classes()).toContain("size-control");
    expect(wrapper.classes()).toContain("rounded-sm");
    expect(wrapper.classes()).toContain("text-fg-secondary");
    expect(wrapper.get("svg").attributes("width")).toBe("16");
  });

  it("renders slot content when no icon prop is given", () => {
    const wrapper = mountWithI18n(IconButton, {
      props: { label: "Custom" },
      slots: { default: "<i data-testid='custom' />" },
    });
    expect(wrapper.find("[data-testid='custom']").exists()).toBe(true);
    expect(wrapper.find("svg").exists()).toBe(false);
  });

  it("omits aria-pressed unless it is a toggle", () => {
    const plain = mountWithI18n(IconButton, { props: { label: "x", icon: Settings } });
    expect(plain.attributes("aria-pressed")).toBeUndefined();

    const off = mountWithI18n(IconButton, {
      props: { label: "x", icon: Settings, pressed: false },
    });
    expect(off.attributes("aria-pressed")).toBe("false");
    expect(off.classes()).not.toContain("bg-selected");

    const on = mountWithI18n(IconButton, { props: { label: "x", icon: Settings, pressed: true } });
    expect(on.attributes("aria-pressed")).toBe("true");
    expect(on.classes()).toContain("bg-selected");
    expect(on.classes()).toContain("text-fg");
  });

  it("disables the button and stops clicks", async () => {
    const onClick = vi.fn();
    const wrapper = mountWithI18n(IconButton, {
      props: { label: "x", icon: Settings, disabled: true },
      attrs: { onClick },
    });
    expect(wrapper.attributes("disabled")).toBeDefined();
    await wrapper.trigger("click");
    expect(onClick).not.toHaveBeenCalled();
  });
});
