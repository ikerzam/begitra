import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeBackend } from "@/test/backend";
import { mountWithI18n } from "@/test/mount";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore } from "@/stores/settings";

import DetailPanel from "./DetailPanel.vue";

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
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

  it("draws each file's kind in its file tree, no folder's, and none once Appearance turns them off", async () => {
    fakeBackend();
    await useRepoStore().open("/r");
    await flushPromises();
    const wrapper = mountWithI18n(DetailPanel, { attachTo: document.body });
    await flushPromises();
    const rows = wrapper.findAll('[data-testid="tree-row"]');
    const files = rows.filter((row) => row.attributes("aria-expanded") === undefined);
    const folders = rows.filter((row) => row.attributes("aria-expanded") !== undefined);
    expect(files.length).toBeGreaterThan(0);
    expect(folders.length).toBeGreaterThan(0);
    for (const row of files) expect(row.find('[data-testid="tree-row-icon"]').exists()).toBe(true);
    for (const row of folders) {
      expect(row.find('[data-testid="tree-row-icon"]').exists()).toBe(false);
    }
    await useSettingsStore().update("fileIcons", false);
    await flushPromises();
    expect(wrapper.find('[data-testid="tree-row-icon"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
