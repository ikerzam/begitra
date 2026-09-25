import { describe, expect, it } from "vitest";

import { EDGE, fitSide, hangList, placeAtPoint } from "./placement";

const viewport = { width: 1440, height: 900 };
const menu = { width: 200, height: 160 };

describe("placeAtPoint", () => {
  it("opens right and below the point when there is room", () => {
    expect(placeAtPoint({ x: 300, y: 200 }, menu, viewport)).toEqual({ left: 300, top: 200 });
  });

  it("opens on the other side of the point along an axis that would cross", () => {
    // The home row's "…" at the right edge, a commit near the status bar.
    expect(placeAtPoint({ x: 1420, y: 250 }, menu, viewport)).toEqual({ left: 1220, top: 250 });
    expect(placeAtPoint({ x: 300, y: 880 }, menu, viewport)).toEqual({ left: 300, top: 720 });
  });

  it("keeps 8px inside when neither side has room", () => {
    expect(placeAtPoint({ x: 100, y: 100 }, { width: 200, height: 1000 }, viewport)).toEqual({
      left: 100,
      top: EDGE,
    });
    expect(placeAtPoint({ x: 150, y: 50 }, menu, { width: 300, height: 900 })).toEqual({
      left: EDGE,
      top: 50,
    });
  });
});

describe("fitSide", () => {
  const start = { align: "start", placement: "bottom" } as const;

  it("keeps the asked side when the popup fits", () => {
    const control = { left: 100, top: 100, right: 124, bottom: 124 };
    const box = { left: 100, top: 128, right: 240, bottom: 156 };
    expect(fitSide(box, control, start, viewport)).toEqual(start);
  });

  it("lines up with the control's other edge at the window's right, and back at its left", () => {
    const control = { left: 1400, top: 10, right: 1424, bottom: 34 };
    const box = { left: 1400, top: 38, right: 1540, bottom: 66 };
    expect(fitSide(box, control, start, viewport)).toEqual({ align: "end", placement: "bottom" });
    const leftControl = { left: 4, top: 10, right: 28, bottom: 34 };
    const leftBox = { left: -112, top: 38, right: 28, bottom: 66 };
    expect(fitSide(leftBox, leftControl, { align: "end", placement: "bottom" }, viewport)).toEqual(
      start,
    );
  });

  it("opens above a control at the bottom and below one at the top", () => {
    const control = { left: 100, top: 870, right: 124, bottom: 894 };
    const box = { left: 100, top: 898, right: 240, bottom: 926 };
    expect(fitSide(box, control, start, viewport)).toEqual({ align: "start", placement: "top" });
    const topControl = { left: 100, top: 2, right: 124, bottom: 26 };
    const topBox = { left: 100, top: -30, right: 240, bottom: -2 };
    expect(fitSide(topBox, topControl, { align: "start", placement: "top" }, viewport)).toEqual(
      start,
    );
  });

  it("leaves a popup with no box where it was asked", () => {
    const none = { left: 0, top: 0, right: 0, bottom: 0 };
    const top = { align: "start", placement: "top" } as const;
    expect(fitSide(none, none, top, viewport)).toEqual(top);
    expect(placeAtPoint({ x: 1500, y: 950 }, { width: 0, height: 0 }, viewport)).toEqual({
      left: 1500,
      top: 950,
    });
  });

  it("stays when the other side has no room either", () => {
    const control = { left: 100, top: 10, right: 124, bottom: 34 };
    const tall = { left: 100, top: 38, right: 240, bottom: 1000 };
    expect(fitSide(tall, control, start, viewport)).toEqual(start);
  });
});

describe("hangList", () => {
  const control = { left: 100, top: 100, right: 196, bottom: 128 };
  const rows = { width: 96, height: 120 };

  it("hangs under the control at its left edge when it fits", () => {
    expect(hangList(control, rows, viewport)).toEqual({ left: 100, top: 132, height: 120 });
  });

  it("goes above a control whose room under it is short", () => {
    const low = { left: 100, top: 800, right: 196, bottom: 828 };
    expect(hangList(low, rows, viewport)).toEqual({ left: 100, top: 676, height: 120 });
  });

  it("takes the side with more room and cuts its height to it when neither fits", () => {
    const short = { width: 1440, height: 600 };
    const tall = { width: 96, height: 290 };
    const higher = { left: 100, top: 280, right: 196, bottom: 308 };
    expect(hangList(higher, tall, short)).toEqual({ left: 100, top: 312, height: 280 });
    const lower = { left: 100, top: 300, right: 196, bottom: 328 };
    expect(hangList(lower, tall, short)).toEqual({ left: 100, top: EDGE, height: 288 });
  });

  it("lines up with the control's right edge when it would cross the window's right", () => {
    const right = { left: 1300, top: 100, right: 1400, bottom: 128 };
    expect(hangList(right, { width: 300, height: 120 }, viewport).left).toBe(1100);
    // Wider than both ways allow: against the window's left edge.
    const narrow = { left: 20, top: 100, right: 60, bottom: 128 };
    expect(hangList(narrow, { width: 1430, height: 120 }, viewport).left).toBe(EDGE);
  });

  it("stays under the control with no height of its own while nothing is laid out", () => {
    expect(hangList(control, { width: 0, height: 0 }, viewport)).toEqual({
      left: 100,
      top: 132,
      height: null,
    });
  });
});
