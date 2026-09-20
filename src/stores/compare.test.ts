import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fakeBackend, fakeCommit, settled } from "@/test/backend";

import { useCompareStore } from "./compare";
import { useRepoStore } from "./repo";
import { useReviewStore } from "./review";
import { memoryStorage, useSettingsStore, type CompareEndpoint } from "./settings";
import { useShellStore } from "./shell";

const main: CompareEndpoint = { kind: "revision", rev: "refs/heads/main", label: "main" };
const feature: CompareEndpoint = {
  kind: "revision",
  rev: "refs/heads/claude/fix-auth",
  label: "claude/fix-auth",
};

async function openRepository() {
  const repo = useRepoStore();
  await repo.open("/r");
  await settled();
  return repo;
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await useSettingsStore().init(memoryStorage(), "windows");
});

afterEach(() => {
  clearMocks();
});

describe("compare store", () => {
  it("opens a comparison: the review target, the counts, the preview and both side lists", async () => {
    const calls = fakeBackend({ rangeCommits: 4 });
    await openRepository();
    const compare = useCompareStore();
    const review = useReviewStore();
    const shell = useShellStore();
    const settings = useSettingsStore();
    await compare.open(main, feature);
    await settled();
    expect(shell.layoutMode).toBe("compare");
    expect(settings.values.compare).toEqual({ a: main, b: feature });
    expect(review.chosenTarget).toEqual({
      kind: "range",
      from: main.rev,
      to: feature.rev,
      threeDot: true,
    });
    expect(compare.comparison?.onlyInA).toBe(4);
    expect(compare.comparison?.onlyInB).toBe(3);
    expect(compare.same).toBe(false);
    expect(compare.preview?.kind).toBe("conflicts");
    expect([...compare.conflicts]).toEqual(["src/lib.ts", "src/other.ts"]);
    // The side lists walk each side against the other's hash, newest first.
    const walks = calls.filter(
      (c) => c.cmd === "walk_commits" && (c.args["scope"] as { kind: string }).kind === "range",
    );
    expect(walks).toHaveLength(2);
    const scopes = walks.map((c) => c.args["scope"]);
    expect(scopes[0]).toEqual({
      kind: "range",
      include: compare.comparison?.a.hash,
      exclude: compare.comparison?.b.hash,
    });
    expect(scopes[1]).toEqual({
      kind: "range",
      include: compare.comparison?.b.hash,
      exclude: compare.comparison?.a.hash,
    });
    expect(compare.sides.a.commits.map((c) => c.hash)).toEqual([
      fakeCommit(0).hash,
      fakeCommit(1).hash,
      fakeCommit(2).hash,
      fakeCommit(3).hash,
    ]);
    expect(compare.sides.a.loading).toBe(false);
    expect(compare.sides.a.done).toBe(true);
    // Only one comparison ran for one open.
    expect(calls.filter((c) => c.cmd === "compare")).toHaveLength(1);
  });

  it("swaps the sides and mirrors the target", async () => {
    const calls = fakeBackend();
    await openRepository();
    const compare = useCompareStore();
    const review = useReviewStore();
    await compare.open(main, feature);
    await settled();
    await compare.swap();
    await settled();
    expect(compare.endpoints).toEqual({ a: feature, b: main });
    expect(review.chosenTarget).toEqual({
      kind: "range",
      from: feature.rev,
      to: main.rev,
      threeDot: true,
    });
    const compares = calls.filter((c) => c.cmd === "compare");
    expect(compares.at(-1)?.args).toMatchObject({ a: feature.rev, b: main.rev });
  });

  it("finds the same commit on both sides and computes no preview", async () => {
    const calls = fakeBackend();
    await openRepository();
    const compare = useCompareStore();
    await compare.open(main, { ...main, rev: main.rev });
    await settled();
    expect(compare.same).toBe(true);
    expect(compare.comparison?.onlyInA).toBe(0);
    expect(calls.filter((c) => c.cmd === "merge_preview")).toHaveLength(0);
    const ranges = calls.filter(
      (c) => c.cmd === "walk_commits" && (c.args["scope"] as { kind: string }).kind === "range",
    );
    expect(ranges).toHaveLength(0);
  });

  it("keeps the endpoints and reports a failed comparison, and a failed preview apart", async () => {
    fakeBackend({ failCompare: true });
    await openRepository();
    const compare = useCompareStore();
    await compare.open(main, feature);
    await settled();
    expect(compare.endpoints).toEqual({ a: main, b: feature });
    expect(compare.comparisonError?.code).toBe("refs.unrelated_histories");
    expect(compare.comparison).toBeNull();
    clearMocks();
    fakeBackend({ failPreview: true });
    await compare.swap();
    await settled();
    expect(compare.comparisonError).toBeNull();
    expect(compare.comparison?.onlyInA).toBe(4);
    expect(compare.previewError?.code).toBe("git.cli_failed");
    expect(compare.sides.b.commits.length).toBeGreaterThan(0);
  });

  it("recomputes when the refs move, and opens a side commit in review focus", async () => {
    const calls = fakeBackend();
    const repo = await openRepository();
    const compare = useCompareStore();
    const review = useReviewStore();
    const shell = useShellStore();
    await compare.open(main, feature);
    await settled();
    const before = calls.filter((c) => c.cmd === "compare").length;
    compare.onRepoChanged(["status"]);
    await settled();
    expect(calls.filter((c) => c.cmd === "compare")).toHaveLength(before);
    compare.onRepoChanged(["refs"]);
    await settled();
    expect(calls.filter((c) => c.cmd === "compare")).toHaveLength(before + 1);
    await compare.openCommit(fakeCommit(2).hash);
    expect(shell.layoutMode).toBe("review");
    expect(review.chosenTarget).toEqual({ kind: "commit", hash: fakeCommit(2).hash });
    expect(repo.selectedCommit?.hash).toBe(fakeCommit(2).hash);
    // Leaving the layout stops the work; coming back recomputes.
    await shell.setLayoutMode("compare");
    await settled();
    expect(calls.filter((c) => c.cmd === "compare")).toHaveLength(before + 2);
    expect(review.chosenTarget).toEqual({
      kind: "range",
      from: main.rev,
      to: feature.rev,
      threeDot: true,
    });
  });
});
