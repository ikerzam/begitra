import { afterEach, describe, expect, it, vi } from "vitest";

import { mountWithI18n } from "@/test/mount";

import CodePopover from "./CodePopover.vue";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function mountPopover(code: { text: string; lines: boolean } | null = null) {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  const wrapper = mountWithI18n(CodePopover, {
    props: { code, anchor },
    attachTo: document.body,
  });
  return { wrapper, anchor };
}

describe("CodePopover", () => {
  it("opens on the search it holds, its text selected, and applies the text with the choice", async () => {
    const { wrapper } = mountPopover({ text: "decodeTile(", lines: true });
    // The field takes the focus once the popover is placed (hidden until then).
    await wrapper.vm.$nextTick();
    const input = wrapper.get<HTMLInputElement>('[data-testid="code-input"]');
    expect(input.element.value).toBe("decodeTile(");
    expect(document.activeElement).toBe(input.element);
    expect(input.element.selectionStart).toBe(0);
    expect(input.element.selectionEnd).toBe("decodeTile(".length);
    expect(input.attributes("maxlength")).toBe("200");
    const lines = wrapper.get<HTMLInputElement>('[data-testid="radio-lines"] input');
    expect(lines.element.checked).toBe(true);
    // git's flags beside the choices, in the mono font.
    expect(wrapper.get('[data-testid="radio-added"]').text()).toContain("Added or removed");
    expect(wrapper.get('[data-testid="radio-added"] .font-mono').text()).toBe("-S");
    expect(wrapper.get('[data-testid="radio-lines"]').text()).toContain("On a changed line");
    expect(wrapper.get('[data-testid="radio-lines"] .font-mono').text()).toBe("-G");
    await input.setValue("retry");
    await wrapper.get('[data-testid="radio-added"] input').setValue(true);
    await input.trigger("keydown", { key: "Enter" });
    expect(wrapper.emitted("apply")).toEqual([[{ text: "retry", lines: false }]]);
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("starts on Added or removed and hands the text over as typed", async () => {
    const { wrapper } = mountPopover();
    const added = wrapper.get<HTMLInputElement>('[data-testid="radio-added"] input');
    expect(added.element.checked).toBe(true);
    // The graph store cleans it, and a blank one clears the search.
    await wrapper.get('[data-testid="code-input"]').setValue("  if (a)\tb ");
    await wrapper.get('[data-testid="code-apply"]').trigger("click");
    expect(wrapper.emitted("apply")).toEqual([[{ text: "  if (a)\tb ", lines: false }]]);
    expect(wrapper.emitted("close")).toEqual([[true]]);
    wrapper.unmount();
  });

  it("closes when the focus leaves it for anything but its button, leaving the focus there", async () => {
    const { wrapper, anchor } = mountPopover({ text: "retry", lines: false });
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    await wrapper.vm.$nextTick();
    const input = wrapper.get('[data-testid="code-input"]');
    // To its own button (Shift Tab, a press on it): its toggle decides.
    await input.trigger("focusout", { relatedTarget: anchor });
    expect(wrapper.emitted("close")).toBeUndefined();
    // Nowhere (the window lost the focus): it stays.
    await input.trigger("focusout", { relatedTarget: null });
    expect(wrapper.emitted("close")).toBeUndefined();
    // Elsewhere (Tab past Apply): it closes without taking the focus back.
    await input.trigger("focusout", { relatedTarget: elsewhere });
    expect(wrapper.emitted("close")).toEqual([[false]]);
    wrapper.unmount();
  });

  it("leaves Enter to an input method's composition", async () => {
    const { wrapper } = mountPopover({ text: "retry", lines: false });
    await wrapper
      .get('[data-testid="code-input"]')
      .trigger("keydown", { key: "Enter", isComposing: true });
    expect(wrapper.emitted("apply")).toBeUndefined();
    wrapper.unmount();
  });

  it("closes without applying on Escape, Cancel, a press outside or a scroll outside", async () => {
    const { wrapper, anchor } = mountPopover({ text: "retry", lines: false });
    await wrapper.get('[data-testid="code-input"]').trigger("keydown", { key: "Escape" });
    expect(wrapper.emitted("close")).toHaveLength(1);
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Cancel")
      ?.trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(2);
    // A press on its own button is the button's toggle, not a press outside.
    anchor.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(wrapper.emitted("close")).toHaveLength(2);
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(wrapper.emitted("close")).toHaveLength(3);
    document.body.dispatchEvent(new Event("scroll"));
    expect(wrapper.emitted("close")).toHaveLength(4);
    expect(wrapper.emitted("apply")).toBeUndefined();
    wrapper.unmount();
  });

  it("is a dialog named by its title", () => {
    const { wrapper } = mountPopover();
    const dialog = wrapper.get('[data-testid="code-popover"]');
    expect(dialog.attributes("role")).toBe("dialog");
    const title = document.getElementById(dialog.attributes("aria-labelledby") ?? "");
    expect(title?.textContent).toBe("Search code changes");
    expect(wrapper.get('[role="radiogroup"]').attributes("aria-label")).toBe("Find the text");
    wrapper.unmount();
  });
});
