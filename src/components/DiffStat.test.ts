import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import DiffStat from "./DiffStat.vue";

describe("DiffStat", () => {
  it("shows added in the add colour and removed in the delete colour", () => {
    const wrapper = mountWithI18n(DiffStat, { props: { added: 128, removed: 4 } });
    const added = wrapper.get("[data-testid='diff-stat-added']");
    const removed = wrapper.get("[data-testid='diff-stat-removed']");
    expect(added.text()).toBe("+128");
    expect(added.classes()).toContain("text-add");
    expect(removed.text()).toBe("−4");
    expect(removed.classes()).toContain("text-del");
    expect(wrapper.attributes("aria-label")).toBe("128 lines added, 4 lines removed");
  });

  it("mutes a zero count", () => {
    const wrapper = mountWithI18n(DiffStat, { props: { added: 0, removed: 318 } });
    expect(wrapper.get("[data-testid='diff-stat-added']").classes()).toContain("text-fg-muted");
    expect(wrapper.get("[data-testid='diff-stat-removed']").classes()).toContain("text-del");
    const empty = mountWithI18n(DiffStat);
    expect(empty.get("[data-testid='diff-stat-added']").text()).toBe("+0");
    expect(empty.get("[data-testid='diff-stat-removed']").text()).toBe("−0");
    expect(empty.get("[data-testid='diff-stat-removed']").classes()).toContain("text-fg-muted");
  });

  it("formats numbers for the locale", () => {
    const en = mountWithI18n(DiffStat, { props: { added: 12400, removed: 0 } });
    expect(en.get("[data-testid='diff-stat-added']").text()).toBe("+12,400");
    const es = mountWithI18n(DiffStat, { props: { added: 12400, removed: 0 } }, { locale: "es" });
    expect(es.get("[data-testid='diff-stat-added']").text()).toBe("+12.400");
    expect(es.attributes("aria-label")).toBe("12.400 líneas añadidas, 0 líneas eliminadas");
  });
});
