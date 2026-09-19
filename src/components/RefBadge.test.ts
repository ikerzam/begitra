import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import RefBadge from "./RefBadge.vue";

describe("RefBadge", () => {
  it.each([
    ["local", "border-ref-local", "Local branch"],
    ["remote", "border-ref-remote", "Remote branch"],
    ["tag", "border-ref-tag", "Tag"],
    ["head", "border-ref-head", "Detached HEAD"],
    ["stash", "border-ref-stash", "Stash"],
  ] as const)("outlines the %s kind in its ref colour with --text label", (kind, cls, title) => {
    const wrapper = mountWithI18n(RefBadge, { props: { kind, label: "x" } });
    expect(wrapper.classes()).toContain(cls);
    expect(wrapper.classes()).toContain("text-fg");
    expect(wrapper.classes()).toContain("rounded-md");
    expect(wrapper.classes()).toContain("border");
    expect(wrapper.classes().some((c) => c.startsWith("bg-"))).toBe(false);
    expect(wrapper.attributes("data-kind")).toBe(kind);
    expect(wrapper.attributes("title")).toBe(title);
  });

  it("fills only the current branch, with a white label", () => {
    const wrapper = mountWithI18n(RefBadge, { props: { kind: "current", label: "main" } });
    expect(wrapper.classes()).toContain("bg-ref-current");
    expect(wrapper.classes()).toContain("border-ref-current");
    expect(wrapper.classes()).toContain("text-white");
    expect(wrapper.text()).toBe("main");
  });

  it("labels a detached HEAD without a name", () => {
    const wrapper = mountWithI18n(RefBadge, { props: { kind: "head" } });
    expect(wrapper.text()).toBe("HEAD");
  });

  it("clips long names instead of wrapping", () => {
    const wrapper = mountWithI18n(RefBadge, {
      props: { kind: "local", label: "claude/migrate-mapbox-to-maplibre" },
    });
    expect(wrapper.get("span span").classes()).toContain("truncate");
    expect(wrapper.classes()).toContain("whitespace-nowrap");
  });

  it("marks a branch checked out in a worktree with a tree icon in its lane colour", () => {
    const wrapper = mountWithI18n(RefBadge, {
      props: { kind: "local", label: "claude/fix-auth", worktreeLane: 4 },
    });
    const icon = wrapper.get("svg");
    expect(icon.attributes("width")).toBe("12");
    expect(icon.classes()).toContain("text-lane-4");
    expect(icon.attributes("role")).toBe("img");
    expect(icon.attributes("aria-label")).toBe("Checked out in a worktree");

    const plain = mountWithI18n(RefBadge, { props: { kind: "local", label: "main" } });
    expect(plain.find("svg").exists()).toBe(false);
  });

  it("translates the marker and the kind titles", () => {
    const wrapper = mountWithI18n(
      RefBadge,
      { props: { kind: "remote", label: "origin/main", worktreeLane: 2 } },
      { locale: "es" },
    );
    expect(wrapper.get("svg").attributes("aria-label")).toBe("Activa en un worktree");
    expect(wrapper.attributes("title")).toBe("Rama remota");
  });
});
