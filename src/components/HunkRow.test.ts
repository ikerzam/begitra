import { describe, expect, it } from "vitest";

import { mountWithI18n } from "@/test/mount";

import HunkRow from "./HunkRow.vue";

describe("HunkRow", () => {
  it("shows the range in mono, the symbol, and the Mark reviewed icon", () => {
    // Inside the code body, the row is interface text in the interface's font and weight.
    const wrapper = mountWithI18n(HunkRow, {
      props: { range: "@@ -12,7 +12,9 @@", symbol: "class TileCache" },
    });
    expect(wrapper.classes()).toContain("h-row-hunk");
    expect(wrapper.classes()).toEqual(expect.arrayContaining(["font-ui", "font-normal"]));
    expect(wrapper.classes()).toContain("bg-hover");
    expect(wrapper.classes()).toContain("border-y");
    expect(wrapper.classes()).toContain("border-line");
    const range = wrapper.get("[data-testid='hunk-row-range']");
    expect(range.text()).toBe("@@ -12,7 +12,9 @@");
    expect(range.classes()).toContain("font-mono");
    expect(range.classes()).toContain("text-fg-muted");
    const symbol = wrapper.get("[data-testid='hunk-row-symbol']");
    expect(symbol.text()).toBe("class TileCache");
    expect(symbol.classes()).toContain("text-fg-secondary");
    const control = wrapper.get("[data-testid='hunk-row-reviewed']");
    expect(control.text()).toBe("");
    expect(control.attributes("aria-label")).toBe("Mark reviewed");
    expect(control.attributes("data-tooltip")).toBe("Mark reviewed");
    expect(control.attributes("aria-pressed")).toBe("false");
    expect(control.classes()).toContain("text-fg-secondary");
    expect(control.get("svg").classes()).toContain("lucide-check");
  });

  it("turns the control --reviewed once the hunk is marked", async () => {
    const wrapper = mountWithI18n(HunkRow, {
      props: { range: "@@ -40,3 +42,5 @@", symbol: "get(key)", reviewed: true },
    });
    const control = wrapper.get("[data-testid='hunk-row-reviewed']");
    expect(control.attributes("aria-label")).toBe("Reviewed");
    expect(control.attributes("aria-pressed")).toBe("true");
    expect(control.classes()).toContain("text-reviewed");
    // The shape changes too, so the state does not rest on the colour.
    expect(control.get("svg").classes()).toContain("lucide-circle-check");
    await control.trigger("click");
    expect(wrapper.emitted("toggleReviewed")).toHaveLength(1);
  });

  it("omits the symbol when git found none and translates the control", () => {
    const wrapper = mountWithI18n(
      HunkRow,
      { props: { range: "@@ -1,2 +1,3 @@" } },
      { locale: "es" },
    );
    expect(wrapper.find("[data-testid='hunk-row-symbol']").exists()).toBe(false);
    expect(wrapper.get("[data-testid='hunk-row-reviewed']").attributes("aria-label")).toBe(
      "Marcar como revisado",
    );
  });
});
