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

  it("holds one toast per slot, telling the one a newer toast replaces", () => {
    const toasts = useToastsStore();
    const gone = vi.fn();
    toasts.push({
      kind: "success",
      message: "one",
      slot: "discard",
      sticky: true,
      onDismiss: gone,
    });
    const other = toasts.push({ kind: "success", message: "other" });
    const second = toasts.push({ kind: "success", message: "two", slot: "discard", sticky: true });
    expect(toasts.toasts.map((toast) => toast.id)).toEqual([other, second]);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("tells a toast it went, unless its action ran", () => {
    const toasts = useToastsStore();
    const gone = vi.fn();
    const acted = vi.fn();
    const id = toasts.push({
      kind: "success",
      message: "x",
      sticky: true,
      onDismiss: gone,
      onAction: acted,
    });
    toasts.act(id);
    expect(acted).toHaveBeenCalledTimes(1);
    expect(gone).not.toHaveBeenCalled();
    expect(toasts.toasts).toEqual([]);

    toasts.push({ kind: "success", message: "timed", onDismiss: gone });
    vi.advanceTimersByTime(AUTO_DISMISS_MS);
    expect(gone).toHaveBeenCalledTimes(1);
    const closed = toasts.push({ kind: "success", message: "closed", onDismiss: gone });
    toasts.dismiss(closed);
    expect(gone).toHaveBeenCalledTimes(2);
    toasts.dismiss(closed);
    expect(gone).toHaveBeenCalledTimes(2);
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
