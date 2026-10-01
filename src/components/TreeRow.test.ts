import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import TreeRow from "./TreeRow.vue";

describe("TreeRow", () => {
  it("renders a file with its status letter, name and stats, indented by depth", () => {
    const wrapper = mountWithI18n(TreeRow, {
      props: { name: "tile-cache.ts", status: "modified", added: 128, removed: 4, depth: 1 },
    });
    expect(wrapper.attributes("role")).toBe("treeitem");
    expect(wrapper.attributes("aria-level")).toBe("2");
    expect(wrapper.attributes("aria-expanded")).toBeUndefined();
    expect(wrapper.classes()).toContain("h-row-tree");
    expect(wrapper.classes()).toContain("pr-2");
    expect(wrapper.attributes("style")).toContain(
      "padding-left: calc(var(--space-3) + var(--space-4) * 1)",
    );
    expect(wrapper.get("[data-status='modified']").text()).toBe("M");
    expect(wrapper.get("[data-testid='tree-row-name']").text()).toBe("tile-cache.ts");
    expect(wrapper.get("[data-testid='tree-row-name']").classes()).toContain("text-fg");
    expect(wrapper.get("[data-testid='diff-stat-added']").text()).toBe("+128");
    expect(wrapper.find("[data-testid='tree-row-chevron']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='tree-row-generated']").exists()).toBe(false);
  });

  it("shows a file's kind as an icon between its status letter and its name, when asked", () => {
    const wrapper = mountWithI18n(TreeRow, {
      props: { name: "pnpm-lock.yaml", status: "modified", kindIcon: true },
    });
    const icon = wrapper.get("[data-testid='tree-row-icon']");
    expect(icon.classes()).toContain("lucide-file-lock");
    expect(icon.classes()).toContain("text-fg-muted");
    expect(icon.attributes("aria-hidden")).toBe("true");
    // The status letter, then the icon, then the name.
    const children = [...wrapper.element.children];
    const at = children.indexOf(icon.element);
    expect(at).toBeGreaterThan(0);
    expect(children[at + 1]?.querySelector("[data-testid='tree-row-name']")).not.toBeNull();
  });

  it("names a file of a flat list first and its folder after it, muted", () => {
    const wrapper = mountWithI18n(TreeRow, {
      props: { name: "tile-cache.ts", folder: "apps/web/src/map", status: "modified" },
    });
    expect(wrapper.get("[data-testid='tree-row-name']").text()).toBe("tile-cache.ts");
    const folder = wrapper.get("[data-testid='tree-row-folder']");
    expect(folder.text()).toBe("apps/web/src/map");
    expect(folder.classes()).toEqual(expect.arrayContaining(["text-sm", "text-fg-muted"]));
    const root = mountWithI18n(TreeRow, { props: { name: "README.md", status: "modified" } });
    expect(root.find("[data-testid='tree-row-folder']").exists()).toBe(false);
  });

  it("draws no icon on a folder, nor on a file the list does not ask one for", () => {
    const folder = mountWithI18n(TreeRow, {
      props: { name: "src", kind: "folder", kindIcon: true },
    });
    expect(folder.find("[data-testid='tree-row-icon']").exists()).toBe(false);
    const file = mountWithI18n(TreeRow, { props: { name: "tile-cache.ts", status: "added" } });
    expect(file.find("[data-testid='tree-row-icon']").exists()).toBe(false);
  });

  it("renders a folder with a chevron, a muted count and aria-expanded", async () => {
    const wrapper = mountWithI18n(TreeRow, {
      props: { name: "packages/map-core/src/layers/vector", kind: "folder", count: 3 },
    });
    expect(wrapper.attributes("aria-expanded")).toBe("false");
    expect(wrapper.get("[data-testid='tree-row-name']").classes()).toContain("text-fg-secondary");
    expect(wrapper.get("[data-testid='tree-row-count']").text()).toBe("3");
    expect(wrapper.get("[data-testid='tree-row-count']").classes()).toContain("text-fg-muted");
    const chevron = wrapper.get("[data-testid='tree-row-chevron']");
    expect(chevron.attributes("aria-label")).toBe("Expand");
    expect(chevron.get("svg").classes()).toContain("lucide-chevron-right");
    expect(chevron.classes()).toContain("size-icon");
    expect(wrapper.find("[data-testid='diff-stat-added']").exists()).toBe(false);

    await chevron.trigger("click");
    expect(wrapper.emitted("toggle")).toHaveLength(1);
    expect(wrapper.emitted("select")).toBeUndefined();

    await wrapper.setProps({ expanded: true });
    expect(wrapper.attributes("aria-expanded")).toBe("true");
    expect(chevron.attributes("aria-label")).toBe("Collapse");
    expect(chevron.get("svg").classes()).toContain("lucide-chevron-down");
  });

  it("toggles a folder with Enter and the arrow keys", async () => {
    const wrapper = mountWithI18n(TreeRow, { props: { name: "infra", kind: "folder" } });
    await wrapper.trigger("keydown", { key: "Enter" });
    await wrapper.trigger("keydown", { key: "ArrowRight" });
    expect(wrapper.emitted("toggle")).toHaveLength(2);
    await wrapper.trigger("keydown", { key: "ArrowLeft" });
    expect(wrapper.emitted("toggle")).toHaveLength(2);
    await wrapper.setProps({ expanded: true });
    await wrapper.trigger("keydown", { key: "ArrowLeft" });
    expect(wrapper.emitted("toggle")).toHaveLength(3);
    expect(wrapper.emitted("activate")).toBeUndefined();
  });

  it("dims generated files and labels them", () => {
    const wrapper = mountWithI18n(TreeRow, {
      props: { name: "openapi.ts", status: "modified", added: 12400, removed: 0, generated: true },
    });
    expect(wrapper.get("[data-testid='tree-row-name']").classes()).toContain("text-fg-muted");
    expect(wrapper.get("[data-testid='tree-row-generated']").text()).toBe("generated");
    expect(wrapper.get("[data-testid='diff-stat-added']").text()).toBe("+12,400");
  });

  it("shows binary in the stats column of a binary file", () => {
    const wrapper = mountWithI18n(TreeRow, {
      props: { name: "tiles-worker.png", status: "added", binary: true },
    });
    expect(wrapper.get("[data-testid='tree-row-binary']").text()).toBe("binary");
    expect(wrapper.get("[data-testid='tree-row-binary']").classes()).toContain("text-fg-muted");
    expect(wrapper.find("[data-testid='diff-stat-added']").exists()).toBe(false);
  });

  it("dims reviewed files and adds the check", () => {
    const wrapper = mountWithI18n(TreeRow, {
      props: { name: "worker.ts", status: "modified", added: 12, removed: 9, reviewed: true },
    });
    expect(wrapper.get("[data-testid='tree-row-name']").classes()).toContain("text-fg-secondary");
    const check = wrapper.get("svg.lucide-check");
    expect(check.classes()).toContain("text-reviewed");
    expect(check.attributes("aria-label")).toBe("Reviewed");
  });

  it("keeps a file changed since its review bright and warns with the check", () => {
    const wrapper = mountWithI18n(TreeRow, {
      props: { name: "worker.ts", status: "modified", added: 12, removed: 9, changed: true },
    });
    expect(wrapper.get("[data-testid='tree-row-name']").classes()).toContain("text-fg");
    const check = wrapper.get("svg.lucide-check");
    expect(check.classes()).toContain("text-warn");
    expect(check.attributes("aria-label")).toBe("Changed since review");
    // A word as well as the colour, and the reason on hover.
    expect(wrapper.get("[data-testid='tree-row-changed']").text()).toBe("changed");
    expect(check.element.parentElement?.getAttribute("data-tooltip")).toBe("Changed since review");
  });

  it("selects on click, activates a file on Enter, and shows the selected treatment", async () => {
    const wrapper = mountWithI18n(TreeRow, {
      props: { name: "lru-map.ts", status: "added", added: 84, removed: 0, selected: true },
    });
    expect(wrapper.attributes("aria-selected")).toBe("true");
    expect(wrapper.attributes("tabindex")).toBe("0");
    expect(wrapper.classes()).toContain("border-accent");
    expect(wrapper.classes()).toContain("bg-selected");
    await wrapper.trigger("click");
    expect(wrapper.emitted("select")).toHaveLength(1);
    await wrapper.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("activate")).toHaveLength(1);
  });

  it("translates the labels", () => {
    const wrapper = mountWithI18n(
      TreeRow,
      { props: { name: "openapi.ts", status: "modified", generated: true, reviewed: true } },
      { locale: "es" },
    );
    expect(wrapper.get("[data-testid='tree-row-generated']").text()).toBe("generado");
    expect(wrapper.get("svg.lucide-check").attributes("aria-label")).toBe("Revisado");
  });
});
