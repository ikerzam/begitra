import { describe, expect, it } from "vitest";

import type { FileChange } from "@/ipc/schemas";
import type { ReviewTarget } from "@/stores/review";
import { changedFile } from "@/test/changes";

import { historyPath, historySide, type HistorySide } from "./fileHistory";

/** A Staged list holding `files`, looked up by path. */
function staged(...files: FileChange[]): (path: string) => FileChange | undefined {
  return (path) => files.find((file) => file.path === path);
}

describe("file history", () => {
  it("a committed change lists the file's own path, a rename's new one included", () => {
    expect(historyPath(changedFile("src/a.ts"), "committed")).toBe("src/a.ts");
    expect(historyPath(changedFile("src/new.ts", { status: "added" }), "committed")).toBe(
      "src/new.ts",
    );
    expect(
      historyPath(changedFile("src/b.ts", { status: "renamed", oldPath: "src/a.ts" }), "committed"),
    ).toBe("src/b.ts");
  });

  it("the index lists the path behind it, and none for a file it adds", () => {
    expect(historyPath(changedFile("src/a.ts"), "index")).toBe("src/a.ts");
    expect(historyPath(changedFile("src/gone.ts", { status: "deleted" }), "index")).toBe(
      "src/gone.ts",
    );
    expect(
      historyPath(changedFile("src/b.ts", { status: "renamed", oldPath: "src/a.ts" }), "index"),
    ).toBe("src/a.ts");
    expect(
      historyPath(changedFile("src/copy.ts", { status: "copied", oldPath: "src/a.ts" }), "index"),
    ).toBe("src/a.ts");
    expect(historyPath(changedFile("src/new.ts", { status: "added" }), "index")).toBeNull();
    expect(historyPath(changedFile("src/c.ts", { status: "unmerged" }), "index")).toBe("src/c.ts");
  });

  it("the working tree goes through the index's own change to the path the commits have", () => {
    // `git mv src/a.ts src/b.ts`, then an edit: the Unstaged row names src/b.ts.
    const moved = staged(changedFile("src/b.ts", { status: "renamed", oldPath: "src/a.ts" }));
    expect(historyPath(changedFile("src/b.ts"), "worktree", moved)).toBe("src/a.ts");
    // `git add new.ts`, then an edit: no commit has it yet.
    const added = staged(changedFile("new.ts", { status: "added" }));
    expect(historyPath(changedFile("new.ts"), "worktree", added)).toBeNull();
    // Untracked, and a file the index does not touch.
    expect(historyPath(changedFile("notes.md", { status: "added" }), "worktree", moved)).toBeNull();
    expect(historyPath(changedFile("src/c.ts"), "worktree", moved)).toBe("src/c.ts");
    expect(historyPath(changedFile("src/c.ts"), "worktree")).toBe("src/c.ts");
  });

  it("names the side of each review target", () => {
    const cases: [ReviewTarget | null, HistorySide][] = [
      [{ kind: "worktree" }, "worktree"],
      [{ kind: "index" }, "index"],
      // Against a revision, a file added since may have commits: its own path, as a range's.
      [{ kind: "revisionToWorktree", revision: "main" }, "committed"],
      [{ kind: "commit", hash: "a".repeat(40) }, "committed"],
      [{ kind: "range", from: "main", to: "HEAD", threeDot: true }, "committed"],
      [null, "committed"],
    ];
    for (const [target, expected] of cases) expect(historySide(target)).toBe(expected);
  });
});
