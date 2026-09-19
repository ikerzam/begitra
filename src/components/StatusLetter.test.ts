import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import StatusLetter from "./StatusLetter.vue";

describe("StatusLetter", () => {
  it.each([
    ["added", "A", "text-add", "Added"],
    ["modified", "M", "text-warn", "Modified"],
    ["deleted", "D", "text-del", "Deleted"],
    ["renamed", "R", "text-warn", "Renamed"],
  ] as const)("renders %s as %s in its semantic colour", (status, letter, cls, title) => {
    const wrapper = mountWithI18n(StatusLetter, { props: { status } });
    expect(wrapper.text()).toBe(letter);
    expect(wrapper.classes()).toContain(cls);
    expect(wrapper.classes()).toContain("font-semibold");
    expect(wrapper.classes()).toContain("w-icon");
    expect(wrapper.classes().some((c) => c.startsWith("bg-"))).toBe(false);
    expect(wrapper.attributes("title")).toBe(title);
    expect(wrapper.attributes("aria-label")).toBe(title);
    expect(wrapper.attributes("data-status")).toBe(status);
  });

  it("translates the title but keeps the git letter", () => {
    const wrapper = mountWithI18n(StatusLetter, { props: { status: "deleted" } }, { locale: "es" });
    expect(wrapper.text()).toBe("D");
    expect(wrapper.attributes("title")).toBe("Borrado");
  });
});
