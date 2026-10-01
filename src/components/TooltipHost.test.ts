import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

import { mountWithI18n } from "@/test/mount";

import TooltipHost from "./TooltipHost.vue";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** An element with a hint, in the document. */
function hinted(text: string, keys?: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.dataset.tooltip = text;
  if (keys) element.dataset.tooltipKeys = keys;
  document.body.append(element);
  return element;
}

function mountHost() {
  return mountWithI18n(TooltipHost, { attachTo: document.body });
}

/** The pointer moves from `from` (the document when null) onto `to`. */
function move(from: Element | null, to: Element): void {
  from?.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: to }));
  to.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, relatedTarget: from }));
}

function leave(from: Element): void {
  from.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
  document.body.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
}

async function wait(ms: number): Promise<void> {
  vi.advanceTimersByTime(ms);
  await nextTick();
  await nextTick();
}

function bubble(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="tooltip"]');
}

describe("TooltipHost", () => {
  it("shows the hint under a resting pointer after half a second, with its keys", async () => {
    const host = mountHost();
    const button = hinted("Changes", "Ctrl 3");
    move(null, button);
    await wait(499);
    expect(bubble()).toBeNull();
    await wait(1);
    const shown = bubble();
    expect(shown?.textContent).toContain("Changes");
    expect(shown?.querySelector("kbd")?.textContent).toBe("Ctrl 3");
    expect(shown?.getAttribute("role")).toBe("tooltip");
    expect(shown?.getAttribute("aria-hidden")).toBe("true");
    expect([...(shown?.classList ?? [])]).toEqual(
      expect.arrayContaining([
        "fixed",
        "pointer-events-none",
        "bg-raised",
        "border-line-strong",
        "shadow-overlay",
        "text-sm",
        "px-2",
        "py-1",
      ]),
    );
    leave(button);
    await wait(0);
    expect(bubble()).toBeNull();
    host.unmount();
  });

  it("shows the next at once while one shows and just after, and waits again later", async () => {
    const host = mountHost();
    const first = hinted("Modified");
    const second = hinted("Added");
    move(null, first);
    await wait(500);
    move(first, second);
    await wait(0);
    expect(bubble()?.textContent).toContain("Added");
    leave(second);
    await wait(200);
    move(document.body, first);
    await wait(0);
    expect(bubble()?.textContent).toContain("Modified");
    leave(first);
    await wait(400);
    move(document.body, second);
    await wait(0);
    expect(bubble()).toBeNull();
    await wait(500);
    expect(bubble()?.textContent).toContain("Added");
    host.unmount();
  });

  it("hides on a press and stays hidden until the pointer leaves the element", async () => {
    const host = mountHost();
    const button = hinted("Discard");
    const icon = document.createElement("span");
    button.append(icon);
    move(null, button);
    await wait(500);
    button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    await wait(0);
    expect(bubble()).toBeNull();
    move(button, icon);
    await wait(600);
    expect(bubble()).toBeNull();
    leave(button);
    move(document.body, button);
    await wait(500);
    expect(bubble()?.textContent).toContain("Discard");
    host.unmount();
  });

  it("shows for a focus a key moved, not one a press moved, and any key hides it", async () => {
    const host = mountHost();
    const first = hinted("Settings", "Ctrl ,");
    const second = hinted("Graph focus");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    first.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await wait(500);
    expect(bubble()?.textContent).toContain("Settings");
    // A key hides it; the focus it moves waits the whole delay again.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    first.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    second.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await wait(0);
    expect(bubble()).toBeNull();
    await wait(500);
    expect(bubble()?.textContent).toContain("Graph focus");
    second.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await wait(0);
    expect(bubble()).toBeNull();
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    first.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await wait(600);
    expect(bubble()).toBeNull();
    host.unmount();
  });

  it("shows nothing under a held button, for a control whose popup is open, or on a focused list row", async () => {
    const host = mountHost();
    const divider = hinted("Resize the sidebar");
    const switcher = hinted("Switch repository");
    switcher.setAttribute("aria-haspopup", "menu");
    switcher.setAttribute("aria-expanded", "true");
    const row = hinted("apps/web/src/map/tile-cache.ts");
    row.setAttribute("role", "treeitem");
    divider.dispatchEvent(new MouseEvent("pointerover", { bubbles: true, buttons: 1 }));
    await wait(600);
    expect(bubble()).toBeNull();
    move(divider, switcher);
    await wait(600);
    expect(bubble()).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "j" }));
    row.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await wait(600);
    expect(bubble()).toBeNull();
    // The pointer still shows a row's path.
    move(switcher, row);
    await wait(500);
    expect(bubble()?.textContent).toContain("tile-cache.ts");
    host.unmount();
  });

  it("shows the hint of an open disclosure, whose content opens in place", async () => {
    const host = mountHost();
    const toggle = hinted("Hide git's output");
    toggle.setAttribute("aria-expanded", "true");
    toggle.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    await wait(600);
    expect(bubble()?.textContent).toContain("Hide git's output");
    host.unmount();
  });

  it("hides when the window loses the focus, and its return shows nothing", async () => {
    const host = mountHost();
    const button = hinted("Fetch");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    button.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await wait(500);
    expect(bubble()).not.toBeNull();
    window.dispatchEvent(new Event("blur"));
    await wait(0);
    expect(bubble()).toBeNull();
    // The platform gives the focus back to the button: no key of the app's moved it.
    button.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await wait(600);
    expect(bubble()).toBeNull();
    host.unmount();
  });

  it("hides on a scroll, on a resize and over an element without a hint", async () => {
    const host = mountHost();
    const button = hinted("Fetch");
    const plain = document.createElement("div");
    document.body.append(plain);
    for (const dismiss of [
      () => document.dispatchEvent(new Event("scroll")),
      () => window.dispatchEvent(new Event("resize")),
      () => move(button, plain),
    ]) {
      leave(button);
      await wait(1000);
      move(document.body, button);
      await wait(500);
      expect(bubble()).not.toBeNull();
      dismiss();
      await wait(0);
      expect(bubble()).toBeNull();
    }
    host.unmount();
  });

  it("hangs under its element, and above it at the window's bottom", async () => {
    const host = mountHost();
    const button = hinted("A long path/to/a/file.ts");
    let at = DOMRect.fromRect({ x: 100, y: 100, width: 24, height: 24 });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this === button ? at : DOMRect.fromRect({ x: 0, y: 0, width: 160, height: 26 });
    });
    move(null, button);
    await wait(500);
    // jsdom's window is 1024 x 768: 4px under the button.
    expect(bubble()?.style.top).toBe("128px");
    expect(bubble()?.style.left).toBe("100px");
    expect(bubble()?.style.visibility).toBe("");
    leave(button);
    at = DOMRect.fromRect({ x: 100, y: 740, width: 24, height: 24 });
    await wait(1000);
    move(document.body, button);
    await wait(500);
    expect(bubble()?.style.top).toBe("710px");
    host.unmount();
  });

  it("measures each bubble at its own width from the origin, not where the last one stood", async () => {
    const host = mountHost();
    const corner = hinted("Changes");
    const path = hinted("packages/map-core/src/layers/vector/tiles/worker-pool-scheduler.ts");
    const measuredAt: string[] = [];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.testid === "tooltip") {
        measuredAt.push(`${this.style.left} ${this.style.top}`);
        return DOMRect.fromRect({ x: 0, y: 0, width: 120, height: 26 });
      }
      const x = this === corner ? 1000 : 400;
      return DOMRect.fromRect({ x, y: 100, width: 24, height: 24 });
    });
    move(null, corner);
    await wait(500);
    expect(bubble()?.style.left).toBe("896px");
    leave(corner);
    move(document.body, path);
    await wait(0);
    // Near the window's right edge the room would squeeze a bubble measured there.
    expect(measuredAt).toEqual(["0px 0px", "0px 0px"]);
    expect(bubble()?.classList).toContain("w-max");
    // The bubble's 4px radius.
    expect(bubble()?.classList).toContain("rounded-sm");
    host.unmount();
  });
});
