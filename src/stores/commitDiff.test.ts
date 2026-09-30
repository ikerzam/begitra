import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeBackend, settled } from "@/test/backend";

import { useOperationsStore } from "./operations";
import { SLOW_DIFF_MS, useRepoStore } from "./repo";
import { memoryStorage, useSettingsStore } from "./settings";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  clearMocks();
});

describe("a commit's change set in the status bar", () => {
  it("names a slow change set until its last page arrives", async () => {
    fakeBackend({ diffDelayMs: SLOW_DIFF_MS * 3 });
    const [repo, operations] = [useRepoStore(), useOperationsStore()];
    // Opening selects the first commit, whose change set answers after 450ms.
    await repo.open("/r");
    await wait(SLOW_DIFF_MS * 2);
    expect(operations.current?.label).toBe("operations.loadingDiff");
    await wait(SLOW_DIFF_MS * 2);
    await settled();
    expect(repo.detail?.loading).toBe(false);
    expect(operations.operations.some((op) => op.label === "operations.loadingDiff")).toBe(false);
  });

  it("shows nothing for a quick one, as j and k walk the history", async () => {
    fakeBackend();
    const [repo, operations] = [useRepoStore(), useOperationsStore()];
    const started = vi.spyOn(operations, "start");
    await repo.open("/r");
    await settled();
    repo.select(1);
    repo.select(2);
    await settled();
    await wait(SLOW_DIFF_MS + 50);
    expect(started.mock.calls.some(([, label]) => label === "operations.loadingDiff")).toBe(false);
  });
});
