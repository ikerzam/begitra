import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeBackend } from "@/test/backend";
import { mountWithI18n } from "@/test/mount";
import { useRepoStore } from "@/stores/repo";

import DetailPanel from "./DetailPanel.vue";

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  clearMocks();
});

describe("DetailPanel", () => {
  it("opens the review from the stats line's icon, named Review", async () => {
    fakeBackend();
    await useRepoStore().open("/r");
    await flushPromises();
    const wrapper = mountWithI18n(DetailPanel, { attachTo: document.body });
    await flushPromises();
    const review = wrapper.get('[data-testid="stats-review"]');
    expect(review.attributes("aria-label")).toBe("Review");
    expect(review.attributes("data-tooltip")).toBe("Review");
    expect(review.text()).toBe("");
    expect(review.get("svg").classes()).toContain("lucide-file-diff");
    await review.trigger("click");
    expect(wrapper.emitted("review")).toHaveLength(1);
    wrapper.unmount();
  });
});
