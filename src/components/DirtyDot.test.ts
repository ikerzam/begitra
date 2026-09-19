import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import DirtyDot from "./DirtyDot.vue";

describe("DirtyDot", () => {
  it("is a warn-coloured dot with an accessible name", () => {
    const wrapper = mountWithI18n(DirtyDot);
    expect(wrapper.attributes("role")).toBe("img");
    expect(wrapper.attributes("aria-label")).toBe("Uncommitted changes");
    expect(wrapper.attributes("title")).toBe("Uncommitted changes");
    expect(wrapper.classes()).toContain("bg-warn");
    expect(wrapper.classes()).toContain("rounded-full");
  });

  it("translates its name", () => {
    const wrapper = mountWithI18n(DirtyDot, {}, { locale: "es" });
    expect(wrapper.attributes("aria-label")).toBe("Cambios sin confirmar");
  });
});
