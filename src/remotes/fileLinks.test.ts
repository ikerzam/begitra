import { describe, expect, it } from "vitest";

import type { ChangeKind } from "@/ipc/schemas";

import { fileSourceOf, linkedPath, revealTarget, type FileSource } from "./fileLinks";

const HASH = "c07be21a9f3e4b5d6c7b8a9f0e1d2c3b4a596877";
const refs = [
  { kind: "head", name: "HEAD", fullName: "HEAD", target: HASH },
  { kind: "local-branch", name: "main", fullName: "refs/heads/main", target: "1".repeat(40) },
] as const;

function file(status: ChangeKind, path = "src/tiles.ts", oldPath: string | null = null) {
  return { status, path, oldPath };
}

describe("fileSourceOf", () => {
  it("places a commit's and a range's files at their commit", () => {
    expect(fileSourceOf({ kind: "commit", hash: HASH }, "/r", refs)).toEqual({
      kind: "commit",
      hash: HASH,
    });
    const range = { kind: "range", from: "main", to: "HEAD", threeDot: true } as const;
    expect(fileSourceOf(range, "/r", refs)).toEqual({ kind: "commit", hash: HASH });
    expect(fileSourceOf({ ...range, to: "refs/heads/main" }, "/r", refs)).toEqual({
      kind: "commit",
      hash: "1".repeat(40),
    });
    expect(fileSourceOf({ ...range, to: "c07be21" }, "/r", refs)).toBeNull();
  });

  it("places the working tree's and the index's files in the working tree", () => {
    for (const target of [
      { kind: "worktree" },
      { kind: "index" },
      { kind: "revisionToWorktree", revision: "main" },
    ] as const) {
      expect(fileSourceOf(target, "/r", refs)).toEqual({ kind: "working", root: "/r" });
    }
    expect(fileSourceOf({ kind: "worktree" }, null, refs)).toBeNull();
    expect(fileSourceOf(null, "/r", refs)).toBeNull();
  });
});

describe("linkedPath and revealTarget", () => {
  const commit: FileSource = { kind: "commit", hash: HASH };
  const working: FileSource = { kind: "working", root: "C:\\Code\\geo portal" };

  it("links a commit's file unless the commit deleted it, and reveals none", () => {
    expect(linkedPath(file("modified"), commit)).toBe("src/tiles.ts");
    expect(linkedPath(file("added"), commit)).toBe("src/tiles.ts");
    expect(linkedPath(file("renamed", "src/b.ts", "src/a.ts"), commit)).toBe("src/b.ts");
    expect(linkedPath(file("deleted"), commit)).toBeNull();
    expect(revealTarget(file("modified"), commit)).toBeNull();
    expect(revealTarget(file("modified"), null)).toBeNull();
  });

  it("links a working file the upstream has, by its path there", () => {
    expect(linkedPath(file("modified"), working)).toBe("src/tiles.ts");
    expect(linkedPath(file("deleted"), working)).toBe("src/tiles.ts");
    expect(linkedPath(file("unmerged"), working)).toBe("src/tiles.ts");
    expect(linkedPath(file("renamed", "src/b.ts", "src/a.ts"), working)).toBe("src/a.ts");
    expect(linkedPath(file("added"), working)).toBeNull();
    expect(linkedPath(file("copied", "src/b.ts", "src/a.ts"), working)).toBeNull();
  });

  it("reveals a working file on disk, none deleted", () => {
    const shown = { root: "C:\\Code\\geo portal", path: "C:\\Code\\geo portal\\src\\tiles.ts" };
    expect(revealTarget(file("modified"), working)).toEqual(shown);
    expect(revealTarget(file("added"), working)).toEqual(shown);
    expect(revealTarget(file("deleted"), working)).toBeNull();
  });
});
