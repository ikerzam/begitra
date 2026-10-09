// The files git names when it refuses over local changes, read from its words.

import { describe, expect, it } from "vitest";

import { listsOnOneLine, localChangesIn, tiled } from "./localChanges";

describe("localChangesIn", () => {
  it("reads the files of a switch's refusal", () => {
    expect(
      localChangesIn(
        "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.ts\n\tsrc/dir with space/b.ts\nPlease commit your changes or stash them before you switch branches.\nAborting",
      ),
    ).toEqual({
      changed: ["src/a.ts", "src/dir with space/b.ts"],
      untracked: [],
      untrackedInTheWay: false,
    });
  });

  it("tells untracked files in the way of a merge", () => {
    expect(
      localChangesIn(
        "error: The following untracked working tree files would be overwritten by merge:\n\tnotes.md\nPlease move or remove them before you merge.\nAborting",
      ),
    ).toEqual({ changed: [], untracked: ["notes.md"], untrackedInTheWay: true });
  });

  it("keeps the two lists apart when git gives both", () => {
    expect(
      localChangesIn(
        "error: Your local changes to the following files would be overwritten by merge:\n\ta.ts\nPlease commit your changes or stash them before you merge.\nerror: The following untracked working tree files would be overwritten by merge:\n\tb.md\nPlease move or remove them before you merge.\nAborting",
      ),
    ).toEqual({ changed: ["a.ts"], untracked: ["b.md"], untrackedInTheWay: true });
  });

  it("reads untracked files a switch would remove and folders it would empty", () => {
    expect(
      localChangesIn(
        "error: The following untracked working tree files would be removed by checkout:\n\tx.txt\nPlease move or remove them before you switch branches.\nAborting",
      ),
    ).toEqual({ changed: [], untracked: ["x.txt"], untrackedInTheWay: true });
    expect(
      localChangesIn(
        "error: Updating the following directories would lose untracked files in them:\n\tdocs\n\nAborting",
      ),
    ).toEqual({ changed: [], untracked: ["docs"], untrackedInTheWay: true });
  });

  it("reads merge-ort's one-line list of staged files, by the staged paths when known", () => {
    const refusal =
      "error: Your local changes to the following files would be overwritten by merge:\n  docs/release notes.md u.txt\nMerge with strategy ort failed.";
    expect(listsOnOneLine(refusal)).toBe(true);
    expect(localChangesIn(refusal, ["u.txt", "docs/release notes.md", "other.ts"])).toEqual({
      changed: ["docs/release notes.md", "u.txt"],
      untracked: [],
      untrackedInTheWay: false,
    });
    // Without them, each space separates two paths.
    expect(localChangesIn(refusal).changed).toEqual(["docs/release", "notes.md", "u.txt"]);
  });

  it("names no file for a rebase, which lists none", () => {
    const refusal =
      "error: cannot rebase: You have unstaged changes.\nerror: Please commit or stash them.";
    expect(listsOnOneLine(refusal)).toBe(false);
    expect(localChangesIn(refusal)).toEqual({
      changed: [],
      untracked: [],
      untrackedInTheWay: false,
    });
  });

  it("reads git's lines with Windows line ends too", () => {
    expect(
      localChangesIn(
        "error: Your local changes to the following files would be overwritten by checkout:\r\n\tsrc/a.ts\r\nAborting",
      ),
    ).toEqual({ changed: ["src/a.ts"], untracked: [], untrackedInTheWay: false });
  });
});

describe("tiled", () => {
  it("makes a line up from known paths, the longest first, or says it cannot", () => {
    expect(tiled("a b c", ["a b", "c", "a", "b"])).toEqual(["a b", "c"]);
    // The longest first, but not at the cost of the rest of the line.
    expect(tiled("a b c", ["a b c d", "a b", "a", "b c"])).toEqual(["a", "b c"]);
    expect(tiled("a b", ["a"])).toBeNull();
    expect(tiled("", [])).toEqual([]);
  });
});
