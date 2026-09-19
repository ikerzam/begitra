import { afterEach, describe, expect, it } from "vitest";
import { ref } from "vue";

import { isRendered, useFocusTrap } from "./useFocusTrap";

function panelWith(html: string): HTMLElement {
  const panel = document.createElement("div");
  panel.tabIndex = -1;
  panel.innerHTML = html;
  document.body.append(panel);
  return panel;
}

function tab(shiftKey = false): KeyboardEvent {
  return new KeyboardEvent("keydown", { key: "Tab", shiftKey, cancelable: true });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useFocusTrap", () => {
  it("wraps from the last focusable to the first and back", () => {
    const panel = panelWith('<button id="a">a</button><button id="b">b</button>');
    const trap = useFocusTrap(ref(panel));
    panel.querySelector<HTMLElement>("#b")?.focus();
    const forward = tab();
    expect(trap.onKeydown(forward)).toBe(true);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("a");
    const back = tab(true);
    trap.onKeydown(back);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("b");
  });

  it("lets Tab move between the focusables in the middle", () => {
    const panel = panelWith('<button id="a">a</button><button id="b">b</button>');
    const trap = useFocusTrap(ref(panel));
    panel.querySelector<HTMLElement>("#a")?.focus();
    const forward = tab();
    expect(trap.onKeydown(forward)).toBe(true);
    expect(forward.defaultPrevented).toBe(false);
    expect(document.activeElement?.id).toBe("a");
  });

  it("starts the cycle from an end when the panel itself has the focus", () => {
    const panel = panelWith('<button id="a">a</button><button id="b">b</button>');
    const trap = useFocusTrap(ref(panel));
    panel.focus();
    expect(document.activeElement).toBe(panel);
    const forward = tab();
    trap.onKeydown(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("a");
    panel.focus();
    const back = tab(true);
    trap.onKeydown(back);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("b");
  });

  it("ignores other keys and swallows Tab in a panel without focusables", () => {
    const panel = panelWith("<p>text</p>");
    const trap = useFocusTrap(ref(panel));
    expect(trap.onKeydown(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(false);
    const forward = tab();
    expect(trap.onKeydown(forward)).toBe(true);
    expect(forward.defaultPrevented).toBe(true);
  });

  it("leaves out hidden elements, hidden inputs, disabled controls and tabindex -1", () => {
    const panel = panelWith(
      [
        '<button id="a">a</button>',
        '<input type="hidden" id="h">',
        '<div hidden><button id="inside">x</button></div>',
        '<button id="b" hidden>b</button>',
        '<button id="d" disabled>d</button>',
        '<div id="t" tabindex="-1">t</div>',
        '<a id="l" href="#">l</a>',
      ].join(""),
    );
    expect(
      useFocusTrap(ref(panel))
        .focusables()
        .map((element) => element.id),
    ).toEqual(["a", "l"]);
  });
});

describe("isRendered", () => {
  it("uses the hidden attribute where the engine lays nothing out", () => {
    const panel = panelWith('<button id="a">a</button><button id="b" hidden>b</button>');
    const a = panel.querySelector<HTMLElement>("#a")!;
    const b = panel.querySelector<HTMLElement>("#b")!;
    expect(isRendered(a, false)).toBe(true);
    expect(isRendered(b, false)).toBe(false);
  });

  it("asks for a box where there is layout", () => {
    // jsdom gives no element a box, so with layout assumed nothing is rendered.
    const panel = panelWith('<button id="a">a</button>');
    expect(isRendered(panel.querySelector<HTMLElement>("#a")!, true)).toBe(false);
  });
});
