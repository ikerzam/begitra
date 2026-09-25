import { describe, expect, it } from "vitest";

import type { IndexEntry } from "@/ipc/schemas";
import type { FolderScanState, ScanState } from "@/stores/index";

import { branchLanes, sectionScanState, skeletonAfter, tableSections } from "./sections";

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
const begitra = entry("begitra", { lastOpenedAt: 10 });
const begitraWt = entry("begitra-wt", {
  path: "/wt/begitra-wt",
  kind: "worktree",
  parentPath: "/code/begitra",
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

const worktrees = [claudeAuth, review, begitraWt, orphan];

function source(all: IndexEntry[]) {
  return {
    pinned: [geoportal, orphan, review],
    recent: [begitra],
    all,
    scanRoots: ["/code"],
    worktreesOf: (path: string) =>
      worktrees.filter((w) => w.parentPath === path).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

describe("tableSections", () => {
  it("nests worktrees under their repository, lists every entry once and counts each section's mains", () => {
    const sections = tableSections(source([begitra, geoportal, tiles]));
    expect(sections.map((s) => s.id)).toEqual(["pinned", "recent", "folder:/code"]);
    const [pinned, recent, all] = sections;
    expect(pinned?.rows.map((r) => [r.entry.name, r.nested])).toEqual([
      ["geoportal", false],
      ["claude-auth", true],
      ["review-2.4", true],
      ["orphan", false],
    ]);
    expect(recent?.rows.map((r) => [r.entry.name, r.nested])).toEqual([
      ["begitra", false],
      ["begitra-wt", true],
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
      scanRoots: ["/code", "/empty"],
      worktreesOf: () => [],
    });
    expect(sections.map((s) => s.id)).toEqual(["folder:/code"]);
    expect(
      tableSections({
        pinned: [],
        recent: [],
        all: [],
        scanRoots: ["/code"],
        worktreesOf: () => [],
      }),
    ).toEqual([]);
  });

  it("lists each scan folder's repositories under it in the folders' order, and the rest last", () => {
    const api = entry("api", { path: String.raw`C:\Code\api`, scanRoot: String.raw`C:\Code` });
    const web = entry("web", { path: String.raw`C:\Code\apps\web`, scanRoot: "c:/code/" });
    const job = entry("job", { path: String.raw`D:\work\job`, scanRoot: String.raw`D:\work` });
    const probe = entry("probe", { path: String.raw`E:\tmp\probe`, scanRoot: null });
    const left = entry("left", { path: String.raw`F:\old\left`, scanRoot: String.raw`F:\old` });
    const sections = tableSections({
      pinned: [],
      recent: [],
      all: [api, job, left, probe, web],
      scanRoots: [String.raw`D:\work`, String.raw`C:\Code`],
      worktreesOf: () => [],
    });
    expect(
      sections.map((s) => [s.kind, s.folder, s.count, s.rows.map((r) => r.entry.name)]),
    ).toEqual([
      ["folder", String.raw`D:\work`, 1, ["job"]],
      // The same folder spelled with other case and separators.
      ["folder", String.raw`C:\Code`, 2, ["api", "web"]],
      // Opened on its own, or found in a folder no longer scanned.
      ["other", null, 2, ["left", "probe"]],
    ]);
  });
});

describe("sectionScanState and skeletonAfter", () => {
  const work = String.raw`D:\work`;
  const code = String.raw`C:\Code`;
  const sections = tableSections({
    pinned: [],
    recent: [],
    all: [
      entry("job", { path: String.raw`D:\work\job`, scanRoot: work }),
      entry("api", { path: String.raw`C:\Code\api`, scanRoot: code }),
      entry("probe", { path: String.raw`E:\tmp\probe`, scanRoot: null }),
    ],
    scanRoots: [work, code],
    worktreesOf: () => [],
  });
  const idle: ScanState = { kind: "idle" };
  function scanning(folders: Record<string, FolderScanState>, current: string | null): ScanState {
    return { kind: "scanning", folders, scanned: 0, found: 0, current };
  }

  it("tells what the running scan does with a folder section's folder, whatever its spelling", () => {
    expect(sections.map((s) => s.kind)).toEqual(["folder", "folder", "other"]);
    const scan = scanning({ [work]: "done", "c:/code/": "scanning" }, "c:/code/");
    expect(sections.map((s) => sectionScanState(s, scan))).toEqual(["done", "scanning", undefined]);
    expect(sections.map((s) => sectionScanState(s, idle))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("puts the skeleton rows first while the index loads and under the folder a scan walks", () => {
    expect(skeletonAfter([], false, idle)).toBe(-1);
    expect(skeletonAfter(sections, true, idle)).toBeNull();
    expect(skeletonAfter(sections, true, scanning({ [work]: "scanning" }, work))).toBe(0);
    // A folder with nothing found yet, or no folder walked yet: before the rest.
    const fresh = String.raw`F:\new`;
    expect(skeletonAfter(sections, true, scanning({ [fresh]: "scanning" }, fresh))).toBe(1);
    expect(skeletonAfter(sections, true, scanning({}, null))).toBe(1);
    expect(skeletonAfter(sections.slice(0, 2), true, scanning({}, null))).toBe(1);
    expect(skeletonAfter(sections.slice(2), true, scanning({}, null))).toBe(-1);
  });
});

describe("branchLanes", () => {
  it("gives every branch name one lane by first appearance and none to detached entries", () => {
    const rows = tableSections(source([begitra, geoportal, tiles])).flatMap((s) => s.rows);
    const lanes = branchLanes(rows);
    expect(lanes.get("main")).toBe(1);
    expect(lanes.get("claude/fix-auth")).toBe(2);
    expect(lanes.get("release/2.4")).toBe(3);
    expect(lanes.get("develop")).toBe(4);
    expect(lanes.size).toBe(4);
  });
});
