import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import { memoryStorage, useSettingsStore, type SidebarSectionId } from "@/stores/settings";

import { useSectionFolds } from "./useSectionFolds";

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
});

function folds(counts: Partial<Record<SidebarSectionId, number>>) {
  const filtering = ref(false);
  const matches = ref(counts);
  const scope = effectScope();
  const result = scope.run(() => useSectionFolds(filtering, (id) => matches.value[id] ?? 0));
  if (!result) throw new Error("no folds");
  return { ...result, filtering, matches, stop: () => scope.stop() };
}

describe("useSectionFolds", () => {
  it("reads and writes the stored folds without a filter", () => {
    const { isFolded, setFolded, stop } = folds({ local: 3, remote: 2 });
    expect(isFolded("remote")).toBe(true);
    expect(isFolded("local")).toBe(false);
    setFolded("local", true);
    setFolded("remote", false);
    expect(useSettingsStore().values.sidebarFolded).toEqual(["tags", "local"]);
    stop();
  });

  it("folds what the filter leaves empty and opens what it matches", () => {
    const { isFolded, filtering, matches, stop } = folds({ local: 0, remote: 2 });
    filtering.value = true;
    expect(isFolded("local")).toBe(true);
    expect(isFolded("remote")).toBe(false);
    matches.value = { local: 1, remote: 0 };
    expect(isFolded("local")).toBe(false);
    expect(isFolded("remote")).toBe(true);
    stop();
  });

  it("keeps a state chosen while filtering as the matches change, and drops it with the filter", async () => {
    const { isFolded, setFolded, filtering, matches, stop } = folds({ local: 2, remote: 0 });
    filtering.value = true;
    setFolded("local", true);
    setFolded("remote", false);
    matches.value = { local: 0, remote: 4 };
    expect(isFolded("local")).toBe(true);
    matches.value = { local: 5, remote: 0 };
    expect(isFolded("local")).toBe(true);
    expect(isFolded("remote")).toBe(false);
    // The stored folds are untouched.
    expect(useSettingsStore().values.sidebarFolded).toEqual(["remote", "tags"]);
    filtering.value = false;
    await nextTick();
    expect(isFolded("local")).toBe(false);
    expect(isFolded("remote")).toBe(true);
    // The next filter starts from the matches again.
    filtering.value = true;
    await nextTick();
    expect(isFolded("local")).toBe(false);
    stop();
  });
});
