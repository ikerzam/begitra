import { describe, expect, it } from "vitest";
import { h } from "vue";

import { mountWithI18n } from "@/test/mount";

import DiffRow from "./DiffRow.vue";

describe("DiffRow", () => {
  it("renders a context line with both numbers in muted mono and no tint", () => {
    const wrapper = mountWithI18n(DiffRow, {
      props: { oldNumber: 12, newNumber: 12, code: "export class TileCache {" },
    });
    expect(wrapper.classes()).toContain("h-row-diff");
    expect(wrapper.classes()).toContain("font-mono");
    expect(wrapper.classes()).toContain("text-code");
    expect(wrapper.classes()).toContain("whitespace-pre");
    expect(wrapper.classes()).toContain("hover:bg-hover");
    expect(wrapper.attributes("data-kind")).toBe("context");
    const old = wrapper.get("[data-testid='diff-row-old']");
    expect(old.text()).toBe("12");
    expect(old.classes()).toContain("text-mono-sm");
    expect(old.classes()).toContain("text-fg-muted");
    expect(old.classes()).toContain("select-none");
    expect(wrapper.get("[data-testid='diff-row-new']").text()).toBe("12");
    expect(wrapper.get("[data-testid='diff-row-marker']").text()).toBe("");
    expect(wrapper.get("[data-testid='diff-row-code']").text()).toBe("export class TileCache {");
  });

  it("tints a removed line and marks it with a minus", () => {
    const wrapper = mountWithI18n(DiffRow, {
      props: { kind: "del", oldNumber: 13, code: "  private map = new Map()" },
    });
    expect(wrapper.classes()).toContain("bg-del-bg");
    expect(wrapper.get("[data-testid='diff-row-new']").text()).toBe("");
    const marker = wrapper.get("[data-testid='diff-row-marker']");
    expect(marker.text()).toBe("-");
    expect(marker.classes()).toContain("text-del");
  });

  it("tints an added line, marks it with a plus and keeps emphasis spans from the slot", () => {
    const wrapper = mountWithI18n(DiffRow, {
      props: { kind: "add", newNumber: 13 },
      slots: {
        default: () => [
          "  private map = new ",
          h("span", { class: "rounded-sm bg-add-emphasis" }, "LruMap<string, Tile>(512)"),
        ],
      },
    });
    expect(wrapper.classes()).toContain("bg-add-bg");
    expect(wrapper.get("[data-testid='diff-row-marker']").text()).toBe("+");
    expect(wrapper.get("[data-testid='diff-row-marker']").classes()).toContain("text-add");
    expect(wrapper.get("[data-testid='diff-row-code']").element.textContent).toBe(
      "  private map = new LruMap<string, Tile>(512)",
    );
    expect(wrapper.get(".bg-add-emphasis").text()).toBe("LruMap<string, Tile>(512)");
  });

  it("renders the empty side of a side-by-side pair as a hover-wash gap", () => {
    const wrapper = mountWithI18n(DiffRow, { props: { kind: "gap" } });
    expect(wrapper.classes()).toContain("bg-hover");
    expect(wrapper.text()).toBe("");
  });
});
