import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";

import type { FileChange } from "@/ipc/schemas";

import { useReviewStore } from "./review";

function file(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return {
    status: "modified",
    path,
    oldPath: null,
    similarity: null,
    additions: 1,
    deletions: 0,
    hunks: [],
    isBinary: false,
    isLarge: false,
    isGenerated: false,
    isTest: false,
    ...overrides,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("review store", () => {
  it("opens a commit on the chosen file and lifts the filter that would hide it", () => {
    const review = useReviewStore();
    review.open("a", file("pnpm-lock.yaml", { isGenerated: true }));
    expect(review.commitHash).toBe("a");
    expect(review.selectedPath).toBe("pnpm-lock.yaml");
    expect(review.filters.hideLockfiles).toBe(false);
    expect(review.filters.hideGenerated).toBe(true);

    review.open("a", file("apps/api/openapi.ts", { isGenerated: true }));
    expect(review.filters.hideGenerated).toBe(false);

    review.setFilter("hideTests", true);
    review.open("a", file("apps/api/tiles.test.ts", { isTest: true }));
    expect(review.filters.hideTests).toBe(false);
    expect(review.selectedPath).toBe("apps/api/tiles.test.ts");
  });

  it("keeps the selection and the marks for the same commit and forgets them for another", () => {
    const review = useReviewStore();
    review.open("a", file("src/app.ts"));
    review.toggleReviewed("src/app.ts");
    review.open("a", null);
    expect(review.selectedPath).toBe("src/app.ts");
    expect(review.reviewedCount).toBe(1);

    review.open("b", null);
    expect(review.selectedPath).toBeNull();
    expect(review.reviewedCount).toBe(0);
  });
});

describe("review store, pinned commits", () => {
  it("keeps the diff base and the range end until cleared", () => {
    const store = useReviewStore();
    expect(store.diffBase).toBeNull();
    store.setDiffBase("a1b2c3d4");
    store.setRangeEnd("e5f6a7b8");
    expect(store.diffBase).toBe("a1b2c3d4");
    expect(store.rangeEnd).toBe("e5f6a7b8");
    store.setDiffBase(null);
    expect(store.diffBase).toBeNull();
    expect(store.rangeEnd).toBe("e5f6a7b8");
    store.clearPins();
    expect(store.rangeEnd).toBeNull();
  });
});
