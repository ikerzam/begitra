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
    // The app's tooltip shows the label; no native title doubles it.
    expect(wrapper.attributes("data-tooltip")).toBe("Settings");
    expect(wrapper.attributes("data-tooltip-keys")).toBeUndefined();
    expect(wrapper.attributes("title")).toBeUndefined();
    expect(wrapper.classes()).toContain("size-5");
    expect(wrapper.classes()).toContain("rounded-sm");
    expect(wrapper.classes()).toContain("text-fg-secondary");
    expect(wrapper.get("svg").attributes("width")).toBe("16");
  });

  it("renders 32px for the rail", () => {
    const wrapper = mountWithI18n(IconButton, {
      props: { label: "Repos", icon: Settings, size: "lg" },
    });
    expect(wrapper.classes()).toContain("size-6");
    expect(wrapper.classes()).not.toContain("size-5");
    expect(wrapper.attributes("aria-label")).toBe("Repos");
  });

  it("gives its tooltip a text of its own and a shortcut when asked", () => {
    const wrapper = mountWithI18n(IconButton, {
      props: { label: "Changes, 5 files", tooltip: "Changes", keys: "Ctrl 3", icon: Settings },
    });
    expect(wrapper.attributes("aria-label")).toBe("Changes, 5 files");
    expect(wrapper.attributes("data-tooltip")).toBe("Changes");
    expect(wrapper.attributes("data-tooltip-keys")).toBe("Ctrl 3");
    // The bubble is aria-hidden: the shortcut reaches assistive technology this way.
    expect(wrapper.attributes("aria-description")).toBe("Ctrl 3");
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
    // The pressed fill stays under the pointer; only a released toggle takes the hover fill.
    expect(on.classes()).not.toContain("enabled:hover:bg-hover");
    expect(off.classes()).toContain("enabled:hover:bg-hover");
  });

  it("shows a count after the icon, formatted, capped at 999+ and absent at zero", async () => {
    const wrapper = mountWithI18n(IconButton, {
      props: { label: "Changes", icon: Settings, count: 0 },
    });
    expect(wrapper.find('[data-testid="icon-button-count"]').exists()).toBe(false);
    expect(wrapper.classes()).toContain("size-5");
    await wrapper.setProps({ count: 42 });
    expect(wrapper.get('[data-testid="icon-button-count"]').text()).toBe("42");
    expect(wrapper.classes()).toContain("min-w-5");
    await wrapper.setProps({ count: 999 });
    expect(wrapper.get('[data-testid="icon-button-count"]').text()).toBe("999");
    await wrapper.setProps({ count: 12_345 });
    expect(wrapper.get('[data-testid="icon-button-count"]').text()).toBe("999+");
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
