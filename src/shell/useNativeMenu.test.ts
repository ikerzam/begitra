import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";

import { menuOutcome, useNativeMenu, type TextMenuRequest } from "./useNativeMenu";

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

function rightClick(target: EventTarget): MouseEvent {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 60,
  });
  target.dispatchEvent(event);
  return event;
}

describe("menuOutcome", () => {
  it("leaves an app menu's click alone and keeps the platform's menu in a text field", () => {
    const field = document.createElement("textarea");
    const handled = new MouseEvent("contextmenu", { cancelable: true });
    handled.preventDefault();
    expect(menuOutcome(handled, null)).toBe("app");
    const inField = new MouseEvent("contextmenu", { cancelable: true });
    Object.defineProperty(inField, "target", { value: field });
    expect(menuOutcome(inField, null)).toBe("native");
  });
});

describe("useNativeMenu", () => {
  const requests: TextMenuRequest[] = [];
  const Host = defineComponent({
    setup() {
      useNativeMenu((request) => requests.push(request));
      return () =>
        h("div", [
          h("header", { "data-testid": "header" }, "Files 48"),
          h("pre", { "data-testid": "code" }, "const pool = new WorkerPool(4);"),
          h("input", { "data-testid": "field" }),
          h("div", {
            "data-testid": "row",
            onContextmenu: (event: MouseEvent) => event.preventDefault(),
          }),
        ]);
    },
  });

  it("takes the webview's menu away everywhere but text fields, and offers Copy on a selection", () => {
    requests.length = 0;
    const wrapper = mount(Host, { attachTo: document.body });
    // Nothing where the app has no menu.
    expect(rightClick(wrapper.get('[data-testid="header"]').element).defaultPrevented).toBe(true);
    expect(requests).toEqual([]);
    // A text field keeps the platform's edit menu.
    expect(rightClick(wrapper.get('[data-testid="field"]').element).defaultPrevented).toBe(false);
    // Selected text gets the app's menu at the pointer with the text to copy (jsdom's
    // selection serialises nothing, so the selection is the browser's shape here).
    const code = wrapper.get('[data-testid="code"]').element;
    const selected = {
      isCollapsed: false,
      toString: () => "const pool = new WorkerPool(4);",
      containsNode: (node: Node) => code.contains(node),
    } as unknown as Selection;
    const getSelection = vi.spyOn(window, "getSelection").mockReturnValue(selected);
    expect(rightClick(code).defaultPrevented).toBe(true);
    expect(requests).toEqual([{ x: 40, y: 60, text: "const pool = new WorkerPool(4);" }]);
    // A click away from the selection, and a row with its own menu, open no text menu.
    expect(rightClick(wrapper.get('[data-testid="header"]').element).defaultPrevented).toBe(true);
    rightClick(wrapper.get('[data-testid="row"]').element);
    expect(requests).toHaveLength(1);
    getSelection.mockRestore();
    wrapper.unmount();
  });
});
