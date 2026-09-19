import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import AheadBehind from "./AheadBehind.vue";

describe("AheadBehind", () => {
  it("shows ahead in --ok and a zero behind muted, with 12px arrows", () => {
    const wrapper = mountWithI18n(AheadBehind, { props: { ahead: 2, behind: 0 } });
    const ahead = wrapper.get("[data-testid='ahead']");
    const behind = wrapper.get("[data-testid='behind']");
    expect(ahead.text()).toBe("2");
    expect(ahead.classes()).toContain("text-ok");
    expect(behind.text()).toBe("0");
    expect(behind.classes()).toContain("text-fg-muted");
    expect(ahead.get("svg").classes()).toContain("lucide-arrow-up");
    expect(ahead.get("svg").attributes("width")).toBe("12");
    expect(behind.get("svg").classes()).toContain("lucide-arrow-down");
    expect(wrapper.attributes("aria-label")).toBe("2 ahead, 0 behind");
    expect(wrapper.classes()).toContain("text-sm");
  });

  it("shows behind in --warn", () => {
    const wrapper = mountWithI18n(AheadBehind, { props: { ahead: 0, behind: 3 } });
    expect(wrapper.get("[data-testid='ahead']").classes()).toContain("text-fg-muted");
    expect(wrapper.get("[data-testid='behind']").classes()).toContain("text-warn");
  });

  it("defaults to zero and translates the label", () => {
    const wrapper = mountWithI18n(AheadBehind, {}, { locale: "es" });
    expect(wrapper.attributes("aria-label")).toBe("0 por delante, 0 por detrás");
  });
});
