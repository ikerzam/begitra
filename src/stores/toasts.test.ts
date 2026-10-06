import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTO_DISMISS_MS, useToastsStore } from "./toasts";

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("toasts store", () => {
  it("dismisses a toast after a few seconds and keeps an error until dismissed", () => {
    const toasts = useToastsStore();
    toasts.push({ kind: "success", message: "done" });
    const error = toasts.push({ kind: "error", message: "failed" });
    vi.advanceTimersByTime(AUTO_DISMISS_MS);
    expect(toasts.toasts.map((toast) => toast.id)).toEqual([error]);
    toasts.dismiss(error);
    expect(toasts.toasts).toEqual([]);
  });

  it("keeps a sticky toast, the only way back to what it names, until dismissed", () => {
    const toasts = useToastsStore();
    const kept = toasts.push({ kind: "success", message: "deleted", sticky: true });
    vi.advanceTimersByTime(AUTO_DISMISS_MS * 10);
    expect(toasts.toasts.map((toast) => toast.id)).toEqual([kept]);
    toasts.dismiss(kept);
    expect(toasts.toasts).toEqual([]);
  });
});
