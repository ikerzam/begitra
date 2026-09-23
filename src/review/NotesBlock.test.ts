import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useReviewStore } from "@/stores/review";
import { useToastsStore } from "@/stores/toasts";
import { settled } from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import NotesBlock from "./NotesBlock.vue";

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NotesBlock", () => {
  it("copies the notes as Markdown once there are notes, and says so", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const review = useReviewStore();
    const wrapper = mountWithI18n(NotesBlock);
    const copy = wrapper.get("[data-testid='copy-notes']");
    expect(copy.attributes("disabled")).toBeDefined();

    review.setNote("src/cache.ts", "Check eviction.");
    await wrapper.vm.$nextTick();
    expect(copy.attributes("disabled")).toBeUndefined();
    await copy.trigger("click");
    await settled();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]).toEqual([expect.stringContaining("## `src/cache.ts`")]);
    expect(useToastsStore().toasts.at(-1)).toMatchObject({
      kind: "success",
      message: "Review notes copied as Markdown",
    });
  });

  it("says so when the webview offers no clipboard", async () => {
    vi.stubGlobal("navigator", {});
    useReviewStore().setNote("src/cache.ts", "Check eviction.");
    const wrapper = mountWithI18n(NotesBlock);
    await wrapper.get("[data-testid='copy-notes']").trigger("click");
    await settled();
    expect(useToastsStore().toasts.at(-1)).toMatchObject({ kind: "error" });
  });
});
