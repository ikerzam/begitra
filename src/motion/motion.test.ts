import { afterEach, describe, expect, it, vi } from "vitest";

import { arm, armed, MOTION_MS, reducedMotion } from "./motion";

afterEach(() => {
  vi.restoreAllMocks();
  reducedMotion.value = false;
});

function at(now: number): void {
  vi.spyOn(performance, "now").mockReturnValue(now);
}

describe("motion", () => {
  it("arms a list for twice the duration, and only that list", () => {
    at(1_000);
    expect(armed("changes")).toBe(false);
    arm("changes");
    expect(armed("changes")).toBe(true);
    expect(armed("branches")).toBe(false);
    at(1_000 + 2 * MOTION_MS - 1);
    expect(armed("changes")).toBe(true);
    at(1_000 + 2 * MOTION_MS);
    expect(armed("changes")).toBe(false);
  });

  it("moves nothing while the system asks for reduced motion", () => {
    at(5_000);
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
