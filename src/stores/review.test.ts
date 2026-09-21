import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FileChange, Hunk } from "@/ipc/schemas";
import { fakeBackend, fakeCommit, settled } from "@/test/backend";

import { useRepoStore } from "./repo";
import { hunkKey, targetKey, targetLabel, useReviewStore, type ReviewTarget } from "./review";
import { useSettingsStore } from "./settings";

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
    isLossy: false,
    ...overrides,
  };
}

async function openRepository() {
  const repo = useRepoStore();
  await repo.open("/r");
  await settled();
  return repo;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  clearMocks();
});

describe("review targets", () => {
  it("has a stable key, an engine target and a label per kind", () => {
    const hash = fakeCommit(1).hash;
    const cases: [ReviewTarget, string, string][] = [
      [{ kind: "commit", hash }, hash, "0000000"],
      [
        { kind: "range", from: "v2.3.1", to: "main", threeDot: false },
        "v2.3.1..main",
        "v2.3.1..main",
      ],
      [
        { kind: "range", from: hash, to: "HEAD", threeDot: true },
        `${hash}...HEAD`,
        "0000000...HEAD",
      ],
      [{ kind: "worktree" }, "worktree", ""],
      [{ kind: "index" }, "index", ""],
      [{ kind: "revisionToWorktree", revision: "v1" }, "v1..worktree", "v1.."],
    ];
    for (const [target, key, label] of cases) {
      expect(targetKey(target)).toBe(key);
      expect(targetLabel(target)).toBe(label);
    }
    const hunk: Hunk = {
      oldStart: 12,
      oldLines: 7,
      newStart: 14,
      newLines: 9,
      header: "@@ -12,7 +14,9 @@ class TileCache",
      lines: [],
    };
    expect(hunkKey(hunk)).toBe("12,14:@@ -12,7 +14,9 @@ class TileCache");
  });
});

describe("review store", () => {
  it("follows the graph selection by default and opens a file lifting its filter", async () => {
    fakeBackend();
    const repo = await openRepository();
    const review = useReviewStore();
    expect(review.target).toEqual({ kind: "commit", hash: fakeCommit(0).hash });
    expect(review.key).toBe(fakeCommit(0).hash);
    // The graph's detail is the change set: no diff of its own.
    expect(review.files.map((f) => f.path)).toEqual([
      "src/00.rs",
      "src/lib.ts",
      "docs/tiles-worker.png",
      "pnpm-lock.yaml",
    ]);
    review.open(fakeCommit(0).hash, file("pnpm-lock.yaml", { isGenerated: true }));
    expect(review.selectedPath).toBe("pnpm-lock.yaml");
    expect(review.filters.hideLockfiles).toBe(false);
    expect(review.filters.hideGenerated).toBe(true);
    review.open(fakeCommit(0).hash, file("apps/api/openapi.ts", { isGenerated: true }));
    expect(review.filters.hideGenerated).toBe(false);
    repo.select(2);
    await settled();
    expect(review.key).toBe(fakeCommit(2).hash);
    expect(review.files[0]?.path).toBe("src/02.rs");
  });

  it("streams its own change set for a chosen target and names it", async () => {
    const calls = fakeBackend();
    await openRepository();
    const review = useReviewStore();
    review.setTarget({ kind: "range", from: "v2.3.1", to: "main", threeDot: false });
    expect(review.changeSet?.loading).toBe(true);
    await settled();
    expect(review.changeSet?.loading).toBe(false);
    expect(review.files[0]?.path).toBe("src/range.rs");
    expect(review.changeSet?.totalFiles).toBe(4);
    const diff = calls.filter((c) => c.cmd === "diff").at(-1);
    expect(diff?.args["target"]).toEqual({
      kind: "range",
      from: "v2.3.1",
      to: "main",
      threeDot: false,
    });
    expect(targetLabel(review.target!)).toBe("v2.3.1..main");
    review.setTarget({ kind: "worktree" });
    await settled();
    expect(calls.filter((c) => c.cmd === "diff").at(-1)?.args["target"]).toEqual({
      kind: "working-tree",
      base: "index",
    });
    review.setTarget({ kind: "revisionToWorktree", revision: "v1" });
    await settled();
    expect(calls.filter((c) => c.cmd === "diff").at(-1)?.args["target"]).toEqual({
      kind: "working-tree",
      base: { revision: { rev: "v1" } },
    });
    // Back to the selection: the own stream goes.
    review.setTarget(null);
    expect(review.changeSet?.files[0]?.path).toBe("src/00.rs");
  });

  it("reports a failed diff and reloads working tree targets on status changes", async () => {
    const calls = fakeBackend({ failDiff: true });
    await openRepository();
    const review = useReviewStore();
    review.setTarget({ kind: "worktree" });
    await settled();
    expect(review.changeSet?.error?.code).toBe("diff.blob_missing");
    expect(review.changeSet?.loading).toBe(false);
    const diffs = () => calls.filter((c) => c.cmd === "diff").length;
    const before = diffs();
    review.onRepoChanged(["refs"]);
    expect(diffs()).toBe(before);
    review.onRepoChanged(["status"]);
    expect(diffs()).toBe(before + 1);
    review.setTarget({ kind: "index" });
    await settled();
    const indexed = diffs();
    review.onRepoChanged(["status"]);
    expect(diffs()).toBe(indexed);
    review.onRepoChanged(["index"]);
    expect(diffs()).toBe(indexed + 1);
  });

  it("marks files and hunks, persists them and counts a file whose hunks are all marked", async () => {
    const calls = fakeBackend();
    await openRepository();
    const review = useReviewStore();
    const target = fakeCommit(0).hash;
    const first = review.files[0]!;
    review.toggleReviewed(first.path);
    expect(review.isReviewed(first.path)).toBe(true);
    expect(review.reviewedCount).toBe(1);
    await settled();
    const writes = calls.filter((c) => c.cmd === "set_annotation");
    expect(writes.at(-1)?.args).toEqual({
      repo: "/r",
      target,
      annotation: { path: first.path, hunk: "", kind: "reviewed", value: "1" },
    });
    review.toggleReviewed(first.path);
    expect(review.isReviewed(first.path)).toBe(false);
    await settled();
    expect(calls.filter((c) => c.cmd === "delete_annotation")).toHaveLength(1);
    // Every hunk marked counts the file.
    const second = review.files[1]!;
    review.toggleHunkReviewed(second.path, second.hunks[0]!);
    expect(review.isHunkReviewed(second.path, second.hunks[0]!)).toBe(true);
    expect(review.isReviewed(second.path)).toBe(true);
    await settled();
    expect(calls.filter((c) => c.cmd === "set_annotation").at(-1)?.args).toMatchObject({
      annotation: { path: second.path, hunk: hunkKey(second.hunks[0]!), kind: "reviewed" },
    });
    // The marks come back for the same target after a reload.
    setActivePinia(createPinia());
    await openRepository();
    const again = useReviewStore();
    await settled();
    expect(again.isReviewed(second.path)).toBe(true);
    expect(again.isReviewed(first.path)).toBe(false);
  });

  it("reverts a mark the backend refused", async () => {
    fakeBackend({ failAnnotations: true });
    await openRepository();
    const review = useReviewStore();
    const path = review.files[0]!.path;
    review.toggleReviewed(path);
    expect(review.isReviewed(path)).toBe(true);
    await settled();
    expect(review.isReviewed(path)).toBe(false);
  });

  it("keeps one note per file, loaded with the target", async () => {
    const hash = fakeCommit(0).hash;
    const calls = fakeBackend({
      annotations: {
        [hash]: [
          { path: "src/lib.ts", hunk: "", kind: "note", value: "Check eviction.", updatedAt: 1 },
          { path: "src/lib.ts", hunk: "", kind: "reviewed", value: "1", updatedAt: 2 },
        ],
      },
    });
    await openRepository();
    const review = useReviewStore();
    await settled();
    expect(review.notes.get("src/lib.ts")).toBe("Check eviction.");
    expect(review.isReviewed("src/lib.ts")).toBe(true);
    review.setNote("src/00.rs", "  Ask about the retry.  ");
    expect(review.notes.get("src/00.rs")).toBe("Ask about the retry.");
    await settled();
    expect(calls.filter((c) => c.cmd === "set_annotation").at(-1)?.args).toMatchObject({
      annotation: { path: "src/00.rs", hunk: "", kind: "note", value: "Ask about the retry." },
    });
    review.setNote("src/lib.ts", "");
    expect(review.notes.has("src/lib.ts")).toBe(false);
    await settled();
    expect(calls.filter((c) => c.cmd === "delete_annotation").at(-1)?.args).toMatchObject({
      annotation: { path: "src/lib.ts", kind: "note" },
    });
  });

  it("remembers the viewer options and recomputes the diff without whitespace", async () => {
    const calls = fakeBackend();
    await openRepository();
    const review = useReviewStore();
    const settings = useSettingsStore();
    expect(review.layout).toBe("unified");
    await review.setLayout("side-by-side");
    await review.setWrap(true);
    expect(settings.values.diffLayout).toBe("side-by-side");
    expect(settings.values.diffWrap).toBe(true);
    const diffs = () => calls.filter((c) => c.cmd === "diff");
    const before = diffs().length;
    await review.setIgnoreWhitespace(true);
    await settled();
    expect(diffs().length).toBe(before + 1);
    expect(diffs().at(-1)?.args["options"]).toMatchObject({ ignoreWhitespace: true });
    expect(review.changeSet?.files[0]?.path).toBe("src/00.rs");
    await review.setIgnoreWhitespace(false);
    expect(diffs().length).toBe(before + 1);
    expect(review.changeSet?.files[0]?.path).toBe("src/00.rs");
  });
});
