// Vitest setup: jsdom has no canvas, so the lane canvas gets a 2D context that records nothing
// and draws nothing. Tests that care about the drawing spy on `getContext` themselves.

import { vi } from "vitest";

const noop = () => undefined;

/** The subset of `CanvasRenderingContext2D` the graph canvas uses. */
export function fakeContext(): Record<string, unknown> {
  return {
    setTransform: noop,
    clearRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    bezierCurveTo: noop,
    stroke: noop,
    arc: noop,
    fill: noop,
    fillText: noop,
    lineWidth: 0,
    lineCap: "butt",
    strokeStyle: "",
    fillStyle: "",
    font: "",
    textAlign: "start",
    textBaseline: "alphabetic",
  };
}

if (typeof HTMLCanvasElement !== "undefined") {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value: vi.fn(() => fakeContext()),
  });
}
