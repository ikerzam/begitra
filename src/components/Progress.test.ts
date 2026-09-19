import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import Progress from "./Progress.vue";

describe("Progress", () => {
  it("is a neutral progressbar whose fill width follows the value", () => {
    const wrapper = mountWithI18n(Progress, { props: { value: 42 } });
    expect(wrapper.attributes("role")).toBe("progressbar");
    expect(wrapper.attributes("aria-valuenow")).toBe("42");
    expect(wrapper.attributes("aria-valuemin")).toBe("0");
    expect(wrapper.attributes("aria-valuemax")).toBe("100");
    expect(wrapper.attributes("aria-label")).toBe("Progress");
    expect(wrapper.classes()).toContain("bg-line-strong");
    const fill = wrapper.get("[data-testid='progress-fill']");
    expect(fill.attributes("style")).toContain("width: 42%");
    expect(fill.classes()).toContain("bg-fg-secondary");
  });

  it("clamps the value into 0..100", () => {
    expect(mountWithI18n(Progress, { props: { value: 150 } }).attributes("aria-valuenow")).toBe(
      "100",
    );
    expect(mountWithI18n(Progress, { props: { value: -5 } }).attributes("aria-valuenow")).toBe("0");
    expect(
      mountWithI18n(Progress, { props: { value: Number.NaN } }).attributes("aria-valuenow"),
    ).toBe("0");
  });

  it("uses --reviewed for review progress", () => {
    const wrapper = mountWithI18n(Progress, { props: { value: 25, variant: "reviewed" } });
    expect(wrapper.get("[data-testid='progress-fill']").classes()).toContain("bg-reviewed");
    expect(wrapper.attributes("data-variant")).toBe("reviewed");
  });

  it("sweeps without a value when indeterminate", () => {
    const wrapper = mountWithI18n(Progress, { props: { indeterminate: true, label: "Indexing" } });
    expect(wrapper.attributes("aria-valuenow")).toBeUndefined();
    expect(wrapper.attributes("aria-busy")).toBe("true");
    expect(wrapper.attributes("aria-label")).toBe("Indexing");
    const fill = wrapper.get("[data-testid='progress-fill']");
    expect(fill.classes()).toContain("progress-sweep");
    expect(fill.attributes("style")).toBeUndefined();
  });

  it("translates the default label", () => {
    const wrapper = mountWithI18n(Progress, {}, { locale: "es" });
    expect(wrapper.attributes("aria-label")).toBe("Progreso");
  });
});
