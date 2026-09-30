import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { arm, armed, motionMs, reducedMotion } from "./motion";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  reducedMotion.value = false;
});

describe("motion", () => {
  it("reads the duration from its token, 140 ms without the style sheet", () => {
    expect(motionMs()).toBe(140);
    document.documentElement.style.setProperty("--motion-duration", "0.2s");
    expect(motionMs()).toBe(200);
    document.documentElement.style.setProperty("--motion-duration", "120ms");
    expect(motionMs()).toBe(120);
    document.documentElement.style.removeProperty("--motion-duration");
  });

  it("arms a list for twice the duration, and only that list", () => {
    expect(armed("changes")).toBe(false);
    arm("changes");
    expect(armed("changes")).toBe(true);
    expect(armed("branches")).toBe(false);
    vi.advanceTimersByTime(2 * 140 - 1);
    expect(armed("changes")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(armed("changes")).toBe(false);
  });

  it("starts the window again when the list is armed again", () => {
    arm("worktrees");
    vi.advanceTimersByTime(200);
    arm("worktrees");
    vi.advanceTimersByTime(200);
    expect(armed("worktrees")).toBe(true);
    vi.advanceTimersByTime(80);
    expect(armed("worktrees")).toBe(false);
  });

  it("moves nothing while the system asks for reduced motion", () => {
    arm("stash");
    reducedMotion.value = true;
    expect(armed("stash")).toBe(false);
    reducedMotion.value = false;
    expect(armed("stash")).toBe(true);
  });

  it("reads the preference from the system when it is known", async () => {
    vi.resetModules();
    const listeners: ((event: { matches: boolean }) => void)[] = [];
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
          listeners.push(listener),
      })),
    );
    const fresh = await import("./motion");
    expect(fresh.reducedMotion.value).toBe(true);
    listeners.forEach((listener) => listener({ matches: false }));
    expect(fresh.reducedMotion.value).toBe(false);
    vi.unstubAllGlobals();
  });
});
