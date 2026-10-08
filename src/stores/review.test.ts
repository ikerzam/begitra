import { clearMocks } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Annotation, FileChange, Hunk, Ref } from "@/ipc/schemas";
import { fakeBackend, fakeCommit, settled } from "@/test/backend";
import * as ipc from "@/ipc/commands";
import { changedFile, repoChange } from "@/test/changes";

import { useRepoStore } from "./repo";
import {
  contentOf,
  hunkKey,
  refsBehind,
  targetKey,
  targetLabel,
  useReviewStore,
  type ReviewTarget,
} from "./review";
import { useSettingsStore } from "./settings";
import { useToastsStore } from "./toasts";

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
    oldId: null,
    newId: null,
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
  });

  it("tells what the refs a target names point at", () => {
    const hash = fakeCommit(0).hash;
    const other = fakeCommit(1).hash;
    const at = (name: string, fullName: string, kind: Ref["kind"], target: string): Ref => ({
      name,
      fullName,
      kind,
      target,
      isCurrent: false,
      upstream: null,
      ahead: null,
      behind: null,
      worktree: null,
      message: null,
      committedAt: null,
    });
    const refs = [
      at("v1", "refs/heads/v1", "local-branch", hash),
      at("v1", "refs/tags/v1", "tag", other),
      at("HEAD", "HEAD", "head", hash),
    ];
    expect(refsBehind({ kind: "commit", hash }, refs)).toBe("");
    expect(refsBehind({ kind: "worktree" }, refs)).toBe("");
    expect(refsBehind({ kind: "index" }, refs)).toBe(`HEAD=${hash}`);
    // A name git could read either way gives both targets; a hash (or a prefix) gives itself.
    expect(refsBehind({ kind: "revisionToWorktree", revision: "v1" }, refs)).toBe(
      `refs/heads/v1=${hash},refs/tags/v1=${other}`,
    );
    expect(
      refsBehind(
        { kind: "range", from: hash.slice(0, 7), to: "refs/tags/v1", threeDot: true },
        refs,
      ),
    ).toBe(`${hash.slice(0, 7)};refs/tags/v1=${other}`);
    // An expression, or a name no ref carries, depends on every ref.
    const every = `refs/heads/v1=${hash}|refs/tags/v1=${other}|HEAD=${hash}`;
    expect(refsBehind({ kind: "revisionToWorktree", revision: "v1~2" }, refs)).toBe(every);
    expect(refsBehind({ kind: "revisionToWorktree", revision: "gone" }, refs)).toBe(every);
  });
});

/** A hunk at `start` with the given changed lines. */
function hunkAt(start: number, removed: string, added: string): Hunk {
  return {
    oldStart: start,
    oldLines: 1,
    newStart: start,
    newLines: 1,
    header: `@@ -${start},1 +${start},1 @@ class TileCache`,
    lines: [
      {
        kind: "removed",
        oldNumber: start,
        newNumber: null,
        text: removed,
        spans: [],
        noNewline: false,
      },
      {
        kind: "added",
        oldNumber: null,
        newNumber: start,
        text: added,
        spans: [],
        noNewline: false,
      },
    ],
  };
}

describe("marks held by content", () => {
  it("keys a hunk by its lines, wherever they are", () => {
    const here = hunkAt(12, "  return a;", "  return b;");
    const moved = hunkAt(40, "  return a;", "  return b;");
    const changed = hunkAt(12, "  return a;", "  return c;");
    expect(hunkKey(here)).toMatch(/^c:[0-9a-f]+$/);
    expect(hunkKey(moved)).toBe(hunkKey(here));
    expect(hunkKey(changed)).not.toBe(hunkKey(here));
  });

  it("counts a file mark while the file shows the ids it was given for", async () => {
    const edited = file("src/cache.ts", { oldId: "a1", newId: "b2", hunks: [hunkAt(3, "x", "y")] });
    const calls = fakeBackend({
      changes: { unstaged: [edited], staged: [] },
      annotations: {
        worktree: [
          // Marked for an older content, and a mark with no content from before.
          { path: "src/cache.ts", hunk: "", kind: "reviewed", value: "a1:b0", updatedAt: 1 },
          { path: "src/old.ts", hunk: "", kind: "reviewed", value: "1", updatedAt: 1 },
        ],
      },
    });
    await openRepository();
    const review = useReviewStore();
    review.setTarget({ kind: "worktree" });
    await settled();
    expect(review.isReviewed("src/cache.ts")).toBe(false);
    expect([...review.changedFiles]).toEqual(["src/cache.ts"]);
    expect(review.reviewedCount).toBe(0);
    expect(review.changedCount).toBe(1);

    // Marking it again takes the content it shows now.
    review.toggleReviewed("src/cache.ts");
    expect(review.isReviewed("src/cache.ts")).toBe(true);
    expect(review.changedCount).toBe(0);
    await settled();
    expect(calls.filter((c) => c.cmd === "set_annotation").at(-1)?.args).toMatchObject({
      target: "worktree",
      annotation: { path: "src/cache.ts", hunk: "", kind: "reviewed", value: "a1:b2" },
    });
  });

  it("counts marks with no content only on a commit, whose diff cannot change", async () => {
    const edited = file("src/cache.ts", { oldId: "a1", newId: "b2", hunks: [hunkAt(3, "x", "y")] });
    const legacyHunk = `3,3:${edited.hunks[0]!.header}`;
    fakeBackend({
      changes: { unstaged: [edited], staged: [] },
      annotations: {
        worktree: [
          { path: "src/cache.ts", hunk: "", kind: "reviewed", value: "1", updatedAt: 1 },
          { path: "src/cache.ts", hunk: legacyHunk, kind: "reviewed", value: "1", updatedAt: 1 },
        ],
      },
    });
    await openRepository();
    const review = useReviewStore();
    review.setTarget({ kind: "worktree" });
    await settled();
    // Neither reviewed nor changed: what was reviewed is not known.
    expect(review.isReviewed("src/cache.ts")).toBe(false);
    expect(review.isHunkReviewed("src/cache.ts", edited.hunks[0]!)).toBe(false);
    expect(review.changedCount).toBe(0);
  });

  it("marks the file with its content once every hunk is marked, so a change shows", async () => {
    const edited = file("src/cache.ts", {
      oldId: "a1",
      newId: "b2",
      hunks: [hunkAt(3, "x", "y"), hunkAt(9, "p", "q")],
    });
    const calls = fakeBackend({ changes: { unstaged: [edited], staged: [] } });
    await openRepository();
    const review = useReviewStore();
    review.setTarget({ kind: "worktree" });
    await settled();
    review.toggleHunkReviewed("src/cache.ts", edited.hunks[0]!);
    expect(review.isReviewed("src/cache.ts")).toBe(false);
    review.toggleHunkReviewed("src/cache.ts", edited.hunks[1]!);
    expect(review.isReviewed("src/cache.ts")).toBe(true);
    await settled();
    expect(
      calls
        .filter((c) => c.cmd === "set_annotation")
        .map((c) => (c.args as { annotation: { hunk: string; value: string } }).annotation),
    ).toContainEqual(expect.objectContaining({ hunk: "", value: "a1:b2" }));
  });

  it("keeps a hunk mark across a shift and drops it when its lines change", async () => {
    // Two hunks, one marked: the file is not reviewed whole, so only the hunk's key decides.
    const before = file("src/cache.ts", {
      oldId: "a1",
      newId: "b2",
      hunks: [hunkAt(3, "x", "y"), hunkAt(20, "m", "n")],
    });
    fakeBackend({ changes: { unstaged: [before], staged: [] } });
    await openRepository();
    const review = useReviewStore();
    review.setTarget({ kind: "worktree" });
    await settled();
    review.toggleHunkReviewed("src/cache.ts", before.hunks[0]!);
    expect(review.isHunkReviewed("src/cache.ts", hunkAt(30, "x", "y"))).toBe(true);
    expect(review.isHunkReviewed("src/cache.ts", hunkAt(3, "x", "z"))).toBe(false);
  });

  it("holds no file mark for a new side that came without an id", async () => {
    // A working file gone between the listing and its id: "a1:-" would also be what the
    // deletion shows after the reload, so no mark may hold it.
    const unread = file("src/cache.ts", { oldId: "a1", newId: null, hunks: [hunkAt(3, "x", "y")] });
    expect(contentOf(unread)).toBeNull();
    expect(contentOf(file("src/gone.ts", { status: "deleted", oldId: "a1" }))).toBe("a1:-");
    expect(contentOf(file("src/both.ts", { status: "unmerged" }))).toBe("-:-");
    const calls = fakeBackend({
      changes: { unstaged: [unread], staged: [] },
      annotations: {
        worktree: [
          { path: "src/cache.ts", hunk: "", kind: "reviewed", value: "a1:-", updatedAt: 1 },
        ],
      },
    });
    await openRepository();
    const review = useReviewStore();
    review.setTarget({ kind: "worktree" });
    await settled();
    expect(review.isReviewed("src/cache.ts")).toBe(false);
    expect(review.isChanged("src/cache.ts")).toBe(true);
    review.toggleReviewed("src/cache.ts");
    expect(review.isReviewed("src/cache.ts")).toBe(false);
    // Its lines can still be marked: a hunk mark holds them, and no file mark follows.
    review.toggleHunkReviewed("src/cache.ts", unread.hunks[0]!);
    await settled();
    const written = calls
      .filter((c) => c.cmd === "set_annotation")
      .map((c) => (c.args as { annotation: { hunk: string } }).annotation.hunk);
    expect(written).toEqual([hunkKey(unread.hunks[0]!)]);
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
    review.onRepoChanged(repoChange({ kinds: ["refs"] }));
    expect(diffs()).toBe(before);
    // A change set in error reads everything again, whatever the paths.
    review.onRepoChanged(repoChange({ kinds: ["status"], paths: ["src/a.ts"] }));
    await settled();
    expect(diffs()).toBe(before + 1);
    review.setTarget({ kind: "index" });
    await settled();
    const indexed = diffs();
    review.onRepoChanged(repoChange({ kinds: ["status"], paths: ["src/a.ts"] }));
    await settled();
    expect(diffs()).toBe(indexed);
    review.onRepoChanged(repoChange({ kinds: ["index"] }));
    await settled();
    expect(diffs()).toBe(indexed + 1);
  });

  it("reads a working tree target again at the paths the watcher names", async () => {
    const calls = fakeBackend({
      changes: { unstaged: [changedFile("src/a.ts"), changedFile("src/b.ts")], staged: [] },
    });
    await openRepository();
    const review = useReviewStore();
    review.setTarget({ kind: "worktree" });
    await settled();
    const count = (cmd: string) => calls.filter((c) => c.cmd === cmd).length;
    const diffs = count("diff");
    review.onRepoChanged(repoChange({ kinds: ["status"], paths: ["src/b.ts"] }));
    await settled();
    expect(count("diff")).toBe(diffs);
    const restricted = calls.filter((c) => c.cmd === "diff_paths");
    expect(restricted).toHaveLength(1);
    expect(restricted[0]?.args["paths"]).toEqual(["src/b.ts"]);
    expect(review.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
    // Staged elsewhere, the file leaves the working tree against the index once read again.
    await ipc.stagePaths("/r", ["src/b.ts"]);
    review.onRepoChanged(repoChange({ kinds: ["status"], paths: ["src/b.ts"] }));
    await settled();
    expect(review.files.map((file) => file.path)).toEqual(["src/a.ts"]);
    expect(count("diff")).toBe(diffs);
    // A commit under review follows nothing.
    review.setTarget(null);
    review.onRepoChanged(repoChange({ kinds: ["status"], paths: ["src/b.ts"] }));
    await settled();
    expect(count("diff_paths")).toBe(2);
  });

  it("computes a target named by refs again when they move, and only then", async () => {
    const at = (name: string, fullName: string, kind: Ref["kind"], commit: number): Ref => ({
      name,
      fullName,
      kind,
      target: fakeCommit(commit).hash,
      isCurrent: kind === "head",
      upstream: null,
      ahead: null,
      behind: null,
      worktree: null,
      message: null,
      committedAt: null,
    });
    const refs = [
      at("agent", "refs/heads/agent", "local-branch", 3),
      at("main", "refs/heads/main", "local-branch", 0),
      at("HEAD", "HEAD", "head", 0),
    ];
    const calls = fakeBackend({ refs });
    const repo = await openRepository();
    const review = useReviewStore();
    const diffs = () => calls.filter((c) => c.cmd === "diff").length;
    const moved = async (index: number, ref: Ref) => {
      refs[index] = ref;
      await repo.refreshRefs();
      await settled();
    };
    review.setTarget({ kind: "range", from: fakeCommit(5).hash, to: "HEAD", threeDot: false });
    await settled();
    let before = diffs();
    // Another branch moves (a commit in a linked worktree): `base..HEAD` stays.
    await moved(0, at("agent", "refs/heads/agent", "local-branch", 4));
    expect(diffs()).toBe(before);
    // A commit from a terminal moves HEAD: the range follows it.
    await moved(2, at("HEAD", "HEAD", "head", 1));
    expect(diffs()).toBe(before + 1);
    // The index against HEAD follows HEAD too.
    review.setTarget({ kind: "index" });
    await settled();
    before = diffs();
    await moved(2, at("HEAD", "HEAD", "head", 2));
    expect(diffs()).toBe(before + 1);
    // A revision named by a branch follows the branch; the selection (a commit) never moves.
    review.setTarget({ kind: "revisionToWorktree", revision: "agent" });
    await settled();
    before = diffs();
    await moved(0, at("agent", "refs/heads/agent", "local-branch", 5));
    expect(diffs()).toBe(before + 1);
    review.setTarget(null);
    before = diffs();
    await moved(2, at("HEAD", "HEAD", "head", 3));
    expect(diffs()).toBe(before);
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
      annotation: { path: first.path, hunk: "", kind: "reviewed", value: contentOf(first) },
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

  it("reverts a mark, a note and a reopen the backend refused, and says so once", async () => {
    fakeBackend({ failAnnotations: true });
    await openRepository();
    const review = useReviewStore();
    const toasts = useToastsStore();
    const path = review.files[0]!.path;
    review.toggleReviewed(path);
    expect(review.isReviewed(path)).toBe(true);
    await settled();
    expect(review.isReviewed(path)).toBe(false);
    expect(toasts.toasts.at(-1)).toMatchObject({
      kind: "error",
      key: "review.markFailed",
      slot: "review-write",
    });

    review.setNote(path, "Check eviction.");
    await settled();
    expect(review.notes.has(path)).toBe(false);
    review.resolutions = new Map([[path, { reply: "Done.", at: 1 }]]);
    review.reopenNote(path);
    await settled();
    expect(review.resolutions.get(path)?.reply).toBe("Done.");
    const shown = toasts.toasts.filter((toast) => toast.slot === "review-write");
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ key: "review.reopenFailed" });
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

  it("shows a note's resolution, reopens it, and reads what an agent wrote on a refresh", async () => {
    const hash = fakeCommit(0).hash;
    const annotations: Record<string, Annotation[]> = {
      [hash]: [
        { path: "src/lib.ts", hunk: "", kind: "note", value: "Check eviction.", updatedAt: 1 },
        {
          path: "src/lib.ts",
          hunk: "",
          kind: "resolved",
          value: "Evicts the oldest tile.",
          updatedAt: 2,
        },
        { path: "src/00.rs", hunk: "", kind: "note", value: "Ask about the retry.", updatedAt: 3 },
      ],
    };
    const calls = fakeBackend({ annotations });
    await openRepository();
    const review = useReviewStore();
    await settled();
    expect(review.resolutions.get("src/lib.ts")).toEqual({
      reply: "Evicts the oldest tile.",
      at: 2,
    });
    expect(review.resolutions.has("src/00.rs")).toBe(false);

    // Reopen takes the resolution off, here and in the store.
    review.reopenNote("src/lib.ts");
    expect(review.resolutions.has("src/lib.ts")).toBe(false);
    await settled();
    expect(calls.filter((c) => c.cmd === "delete_annotation").at(-1)?.args).toMatchObject({
      annotation: { path: "src/lib.ts", hunk: "", kind: "resolved" },
    });
    expect(review.notes.get("src/lib.ts")).toBe("Check eviction.");

    // An agent resolves the other note meanwhile: a refresh shows it, and what shows stays
    // while the read is in flight.
    annotations[hash]!.push({
      path: "src/00.rs",
      hunk: "",
      kind: "resolved",
      value: "Retries twice, then gives up.",
      updatedAt: 4,
    });
    review.refreshAnnotations();
    expect(review.notes.size).toBe(2);
    await settled();
    expect(review.resolutions.get("src/00.rs")?.reply).toBe("Retries twice, then gives up.");

    // Another text is another note: its resolution goes, here and in the store.
    review.setNote("src/00.rs", "Ask about the backoff.");
    expect(review.resolutions.has("src/00.rs")).toBe(false);
    await settled();
    review.refreshAnnotations();
    await settled();
    expect(review.resolutions.has("src/00.rs")).toBe(false);
    // The same text again keeps a resolution.
    annotations[hash]!.push({
      path: "src/00.rs",
      hunk: "",
      kind: "resolved",
      value: "Backs off exponentially.",
      updatedAt: 5,
    });
    review.refreshAnnotations();
    await settled();
    review.setNote("src/00.rs", " Ask about the backoff. ");
    expect(review.resolutions.get("src/00.rs")?.reply).toBe("Backs off exponentially.");
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
