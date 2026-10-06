import { describe, expect, it } from "vitest";

import type { ConflictKind } from "@/ipc/schemas";

import { otherSide, sideHasFile, sideParams } from "./sides";

describe("side names", () => {
  it("name a ref by its name and a commit by its short hash", () => {
    expect(sideParams({ kind: "ref", name: "origin/main" })).toEqual({
      name: "origin/main",
      hash: "",
    });
    const hash = "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4";
    expect(sideParams({ kind: "commit", hash, subject: "x" })).toEqual({
      name: "",
      hash: "a1b2c3d",
    });
    expect(sideParams({ kind: "before", hash, subject: "x" }).hash).toBe("a1b2c3d");
  });

  it("know which side has the file of each kind of conflict", () => {
    const has: Record<ConflictKind, [boolean, boolean]> = {
      "both-modified": [true, true],
      "both-added": [true, true],
      "both-deleted": [false, false],
      "deleted-by-us": [false, true],
      "deleted-by-them": [true, false],
      "added-by-us": [true, false],
      "added-by-them": [false, true],
    };
    for (const [kind, [ours, theirs]] of Object.entries(has) as [
      ConflictKind,
      [boolean, boolean],
    ][]) {
      expect(sideHasFile(kind, "ours"), kind).toBe(ours);
      expect(sideHasFile(kind, "theirs"), kind).toBe(theirs);
    }
    expect(otherSide("ours")).toBe("theirs");
    expect(otherSide("theirs")).toBe("ours");
  });
});
