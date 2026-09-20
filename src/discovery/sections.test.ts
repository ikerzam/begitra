import { describe, expect, it } from "vitest";

import type { IndexEntry } from "@/ipc/schemas";

import { branchLanes, tableSections } from "./sections";

function entry(name: string, over: Partial<IndexEntry> = {}): IndexEntry {
  return {
    path: `/code/${name}`,
    name,
    kind: "main",
    parentPath: null,
    scanRoot: "/code",
    summary: {
      currentBranch: "main",
      detached: false,
      ahead: 0,
      behind: 0,
      lastCommitAt: null,
      dirty: null,
    },
    pinned: false,
    lastOpenedAt: null,
    refreshedAt: null,
    missing: false,
    ...over,
  };
}

const geoportal = entry("geoportal", { pinned: true });
const claudeAuth = entry("claude-auth", {
  path: "/wt/claude-auth",
  kind: "worktree",
  parentPath: "/code/geoportal",
  summary: { ...geoportal.summary, currentBranch: "claude/fix-auth" },
});
const review = entry("review-2.4", {
  path: "/wt/review-2.4",
  kind: "worktree",
  parentPath: "/code/geoportal",
  pinned: true,
  summary: { ...geoportal.summary, currentBranch: "release/2.4" },
});
const begira = entry("begira", { lastOpenedAt: 10 });
const begiraWt = entry("begira-wt", {
  path: "/wt/begira-wt",
  kind: "worktree",
  parentPath: "/code/begira",
  summary: { ...geoportal.summary, currentBranch: "develop" },
});
const tiles = entry("tiles-spike");
const orphan = entry("orphan", {
  path: "/wt/orphan",
  kind: "worktree",
  parentPath: "/code/gone",
  pinned: true,
  summary: { ...geoportal.summary, currentBranch: null, detached: true },
});

const worktrees = [claudeAuth, review, begiraWt, orphan];

function source(all: IndexEntry[]) {
  return {
    pinned: [geoportal, orphan, review],
    recent: [begira],
    all,
    worktreesOf: (path: string) =>
      worktrees.filter((w) => w.parentPath === path).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

describe("tableSections", () => {
  it("nests worktrees under their repository, lists every entry once and counts the mains of All", () => {
    const sections = tableSections(source([begira, geoportal, tiles]));
    expect(sections.map((s) => s.id)).toEqual(["pinned", "recent", "all"]);
    const [pinned, recent, all] = sections;
    expect(pinned?.rows.map((r) => [r.entry.name, r.nested])).toEqual([
      ["geoportal", false],
      ["claude-auth", true],
      ["review-2.4", true],
      ["orphan", false],
    ]);
    expect(recent?.rows.map((r) => [r.entry.name, r.nested])).toEqual([
      ["begira", false],
      ["begira-wt", true],
    ]);
    expect(all?.rows.map((r) => r.entry.name)).toEqual(["tiles-spike"]);
    expect(all?.count).toBe(1);
    expect(pinned?.count).toBe(1);
    const keys = sections.flatMap((s) => s.rows.map((r) => r.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("leaves empty sections out", () => {
    const sections = tableSections({
      pinned: [],
      recent: [],
      all: [tiles],
      worktreesOf: () => [],
    });
    expect(sections.map((s) => s.id)).toEqual(["all"]);
    expect(tableSections({ pinned: [], recent: [], all: [], worktreesOf: () => [] })).toEqual([]);
  });
});

describe("branchLanes", () => {
  it("gives every branch name one lane by first appearance and none to detached entries", () => {
    const rows = tableSections(source([begira, geoportal, tiles])).flatMap((s) => s.rows);
    const lanes = branchLanes(rows);
    expect(lanes.get("main")).toBe(1);
    expect(lanes.get("claude/fix-auth")).toBe(2);
    expect(lanes.get("release/2.4")).toBe(3);
    expect(lanes.get("develop")).toBe(4);
    expect(lanes.size).toBe(4);
  });
});
