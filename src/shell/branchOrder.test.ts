import { describe, expect, it } from "vitest";

import type { Ref as GitRef } from "@/ipc/schemas";

import { sortRefs } from "./branchOrder";

function branch(name: string, committedAt: number | null): GitRef {
  return {
    name,
    fullName: `refs/heads/${name}`,
    kind: "local-branch",
    target: "0".repeat(40),
    isCurrent: false,
    upstream: null,
    ahead: null,
    behind: null,
    worktree: null,
    message: null,
    committedAt,
  };
}

describe("sortRefs", () => {
  const listed = [
    branch("1.6.0", 100),
    branch("feat/geo-241", 900),
    branch("fix/geo-71", 900),
    branch("main", 500),
    branch("old", null),
    branch("older", null),
  ];

  it("puts the most recent first, equal times in name order and undated ones last", () => {
    expect(sortRefs(listed, "recent").map((ref) => ref.name)).toEqual([
      "feat/geo-241",
      "fix/geo-71",
      "main",
      "1.6.0",
      "old",
      "older",
    ]);
  });

  it("keeps the engine's name order by name", () => {
    expect(sortRefs(listed, "name").map((ref) => ref.name)).toEqual(listed.map((r) => r.name));
  });
});
