import { describe, expect, it } from "vitest";

import type { FileChange } from "@/ipc/schemas";
import type { ReviewTarget } from "@/stores/review";
import { changedFile } from "@/test/changes";

import { fileSides } from "./sides";

function sides(target: ReviewTarget, file: FileChange = changedFile("src/a.ts")) {
  const { old, new: current } = fileSides(target, file);
  return { old: old?.at ?? null, new: current?.at ?? null };
}

describe("fileSides", () => {
  it("reads a commit's parent and the commit, and a two-dot range's ends", () => {
    expect(sides({ kind: "commit", hash: "abc" })).toEqual({
      old: { kind: "revision", rev: "abc^" },
      new: { kind: "revision", rev: "abc" },
    });
    expect(sides({ kind: "range", from: "main", to: "topic", threeDot: false })).toEqual({
      old: { kind: "revision", rev: "main" },
      new: { kind: "revision", rev: "topic" },
    });
  });

  it("reads the merge base as the old side of a three-dot range", () => {
    expect(sides({ kind: "range", from: "main", to: "topic", threeDot: true })).toEqual({
      old: { kind: "merge-base", a: "main", b: "topic" },
      new: { kind: "revision", rev: "topic" },
    });
  });

  it("reads the index on the side of the changes lists that it holds", () => {
    // Unstaged: the working tree against the index.
    expect(sides({ kind: "worktree" })).toEqual({
      old: { kind: "index" },
      new: { kind: "working-tree" },
    });
    // Staged: the index against HEAD.
    expect(sides({ kind: "index" })).toEqual({
      old: { kind: "revision", rev: "HEAD" },
      new: { kind: "index" },
    });
  });

  it("leaves the index out for a conflicted path, which has no staged version", () => {
    const conflicted = changedFile("assets/logo.png", { status: "unmerged" });
    expect(sides({ kind: "worktree" }, conflicted)).toEqual({
      old: null,
      new: { kind: "working-tree" },
    });
    expect(sides({ kind: "index" }, conflicted)).toEqual({
      old: { kind: "revision", rev: "HEAD" },
      new: null,
    });
  });

  it("has no old side for an added file and no new side for a deleted one", () => {
    const added = changedFile("src/new.ts", { status: "added" });
    const deleted = changedFile("src/gone.ts", { status: "deleted" });
    expect(sides({ kind: "worktree" }, added)).toEqual({
      old: null,
      new: { kind: "working-tree" },
    });
    expect(sides({ kind: "index" }, deleted)).toEqual({
      old: { kind: "revision", rev: "HEAD" },
      new: null,
    });
  });
});
