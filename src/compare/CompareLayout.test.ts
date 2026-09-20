import { clearMocks } from "@tauri-apps/api/mocks";
import { flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";

import { AppError } from "@/ipc/errors";
import { ShortcutRegistry, setShortcutRegistry } from "@/shortcuts/registry";
import { useCompareStore } from "@/stores/compare";
import { usePickerStore } from "@/stores/picker";
import { useRepoStore } from "@/stores/repo";
import { memoryStorage, useSettingsStore, type CompareEndpoint } from "@/stores/settings";
import { useShellStore } from "@/stores/shell";
import { fakeBackend, settled, type FakeBackendOptions } from "@/test/backend";
import { mountWithI18n } from "@/test/mount";

import CompareLayout from "./CompareLayout.vue";
import MergePreviewBanner from "./MergePreviewBanner.vue";

const main: CompareEndpoint = { kind: "revision", rev: "refs/heads/main", label: "main" };
const feature: CompareEndpoint = {
  kind: "revision",
  rev: "refs/heads/claude/fix-auth",
  label: "claude/fix-auth",
};

beforeEach(async () => {
  setActivePinia(createPinia());
  setShortcutRegistry(new ShortcutRegistry("windows"));
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  setShortcutRegistry(undefined);
  clearMocks();
  document.body.innerHTML = "";
});

async function mountComparison(
  a: CompareEndpoint,
  b: CompareEndpoint,
  options: FakeBackendOptions = {},
) {
  fakeBackend(options);
  await useRepoStore().open("/r");
  await settled();
  await useCompareStore().open(a, b);
  await settled();
  const wrapper = mountWithI18n(CompareLayout, { attachTo: document.body });
  await flushPromises();
  await nextTick();
  return wrapper;
}

describe("CompareLayout", () => {
  it("shows the endpoints, the base line, the conflicts, both side lists and the files", async () => {
    const wrapper = await mountComparison(main, feature, { rangeCommits: 4 });
    expect(wrapper.get('[data-testid="compare-endpoint-a"]').text()).toBe("main");
    expect(wrapper.get('[data-testid="compare-endpoint-b"]').text()).toBe("claude/fix-auth");
    expect(wrapper.get('[data-testid="compare-counts"]').text()).toBe(
      "main is 4 ahead, claude/fix-auth is 3 ahead",
    );
    const banner = wrapper.get('[data-testid="merge-preview-conflicts"]');
    expect(banner.text()).toContain(
      "2 files would conflict if claude/fix-auth were merged into main",
    );
    expect(banner.findAll('[data-testid="conflict-path"]').map((p) => p.text())).toEqual([
      "src/lib.ts",
      "src/other.ts",
    ]);
    expect(banner.text()).toContain(
      "Preview only. Nothing is written until you merge in a terminal.",
    );
    const counts = wrapper.findAll('[data-testid="side-count"]').map((c) => c.text());
    expect(counts).toEqual(["4", "3"]);
    expect(wrapper.get('[data-testid="side-main"]').text()).toContain("Only in main");
    // The files panel names the section and flags the conflicting file.
    expect(wrapper.get('[data-testid="panel-header-title"]').text()).toBe("Files changed");
    expect(wrapper.find('[data-testid="review-target"]').exists()).toBe(false);
    const conflicting = wrapper.findAll('[data-testid="tree-row-conflict"]');
    expect(conflicting).toHaveLength(1);
    wrapper.unmount();
  });

  it("opens the review on the same target and the picker for an endpoint", async () => {
    const wrapper = await mountComparison(main, feature);
    const shell = useShellStore();
    const picker = usePickerStore();
    await wrapper.get('[data-testid="compare-endpoint-b"]').trigger("click");
    expect(picker.mode).toEqual({ kind: "compare", side: "b", other: main });
    picker.close();
    await wrapper.get('[data-testid="open-in-review"]').trigger("click");
    await flushPromises();
    expect(shell.layoutMode).toBe("review");
    wrapper.unmount();
  });

  it("shows the empty state for the same commit and the banner for a failed comparison", async () => {
    const wrapper = await mountComparison(main, main);
    expect(wrapper.get('[data-testid="compare-same"]').text()).toContain(
      "main and main point at the same commit",
    );
    expect(wrapper.get('[data-testid="compare-counts"]').text()).toBe("0 ahead, 0 behind");
    expect(wrapper.find('[data-testid="merge-preview"]').exists()).toBe(false);
    wrapper.unmount();
    clearMocks();
    setActivePinia(createPinia());
    await useSettingsStore().init(memoryStorage(), "windows");
    const failed = await mountComparison(main, feature, { failCompare: true });
    expect(failed.get('[data-testid="compare-error"]').text()).toContain(
      "Couldn't compare main with claude/fix-auth",
    );
    expect(failed.find('[data-testid="compare-sides"]').exists()).toBe(false);
    failed.unmount();
  });
});

describe("MergePreviewBanner", () => {
  it("names every verdict and the failure", () => {
    const names = { a: "main", b: "topic" };
    const forward = mountWithI18n(MergePreviewBanner, {
      props: {
        ...names,
        preview: { kind: "fast-forward", conflicts: [] },
        error: null,
        loading: false,
      },
    });
    expect(forward.text()).toContain("main would fast-forward to topic");
    expect(forward.text()).toContain("main has no commits of its own since the merge base");
    forward.unmount();
    const upToDate = mountWithI18n(MergePreviewBanner, {
      props: {
        ...names,
        preview: { kind: "up-to-date", conflicts: [] },
        error: null,
        loading: false,
      },
    });
    expect(upToDate.text()).toContain("topic is already part of main");
    upToDate.unmount();
    const clean = mountWithI18n(MergePreviewBanner, {
      props: { ...names, preview: { kind: "clean", conflicts: [] }, error: null, loading: false },
    });
    expect(clean.text()).toContain("topic merges cleanly into main");
    clean.unmount();
    const loading = mountWithI18n(MergePreviewBanner, {
      props: { ...names, preview: null, error: null, loading: true },
    });
    expect(loading.get('[data-testid="merge-preview-loading"]').text()).toContain(
      "Computing merge preview",
    );
    loading.unmount();
    const failed = mountWithI18n(MergePreviewBanner, {
      props: {
        ...names,
        preview: null,
        error: new AppError("git.cli_failed", "git merge-tree failed", "fatal: x"),
        loading: false,
      },
    });
    expect(failed.text()).toContain("Couldn't compute the merge preview.");
    expect(failed.text()).toContain("The commit lists and file summary are still correct.");
    expect(failed.text()).toContain("fatal: x");
    failed.unmount();
  });
});
