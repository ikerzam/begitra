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

  it("shows a resolved note dimmed with its reply, and Reopen takes the resolution off", async () => {
    const review = useReviewStore();
    review.setNote("src/auth.ts", "Refresh the token before it expires.");
    review.setNote("src/cache.ts", "Check eviction.");
    review.resolutions = new Map([
      ["src/auth.ts", { reply: "Refreshes the token 60 s before it expires.", at: 2 }],
    ]);
    const wrapper = mountWithI18n(NotesBlock, { attachTo: document.body });
    const notes = wrapper.findAll("[data-testid='note']");
    expect(notes).toHaveLength(2);
    // Open notes first, then the resolved ones.
    const [open, resolved] = notes;
    expect(open!.attributes("data-path")).toBe("src/cache.ts");
    expect(resolved!.get("[data-testid='note-resolved']").text()).toBe("Resolved");
    // Reopen comes after edit and delete.
    expect(resolved!.findAll("button").at(-1)?.attributes("data-testid")).toBe("reopen-note");
    expect(resolved!.get("[data-testid='note-reply']").text()).toBe(
      "Refreshes the token 60 s before it expires.",
    );
    expect(open!.find("[data-testid='note-resolved']").exists()).toBe(false);
    expect(open!.find("[data-testid='reopen-note']").exists()).toBe(false);
    const reopen = resolved!.get<HTMLButtonElement>("[data-testid='reopen-note']");
    reopen.element.focus();
    await reopen.trigger("click");
    await settled();
    expect(review.resolutions.has("src/auth.ts")).toBe(false);
    expect(wrapper.find("[data-testid='note-resolved']").exists()).toBe(false);
    // Reopen left with the resolution: the note's edit button holds the focus.
    const auth = wrapper.get("[data-path='src/auth.ts']");
    expect(document.activeElement).toBe(auth.get("[data-testid='edit-note']").element);
    // A resolution without a reply shows no quote.
    review.resolutions = new Map([["src/cache.ts", { reply: "", at: 3 }]]);
    await wrapper.vm.$nextTick();
    expect(wrapper.find("[data-testid='note-resolved']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='note-reply']").exists()).toBe(false);
    wrapper.unmount();
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
