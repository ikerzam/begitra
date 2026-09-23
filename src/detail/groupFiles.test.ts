import { describe, expect, it } from "vitest";

import type { FileChange } from "@/ipc/schemas";

import {
  applyFilters,
  byDirectory,
  byType,
  groupFiles,
  largest,
  pathMatcher,
  sortBySize,
  statusOf,
  totals,
  typeOf,
} from "./groupFiles";

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

const files = [
  file("apps/web/src/map/worker-pool.ts", { status: "added", additions: 142 }),
  file("apps/web/src/map/map-view.tsx", { additions: 38, deletions: 12 }),
  file("pnpm-lock.yaml", { isGenerated: true, additions: 212, deletions: 190 }),
  file("apps/api/src/openapi.ts", { isGenerated: true, additions: 12_400 }),
  file("apps/api/src/tiles.router.test.ts", { isTest: true, additions: 39 }),
  file("docs/tiles-worker.png", { status: "added", isBinary: true, additions: 0 }),
  file("old.txt", { status: "deleted", additions: 0, deletions: 40 }),
];

describe("groupFiles", () => {
  it("groups by folder in first-seen order with the root last", () => {
    const groups = groupFiles(files);
    expect(groups.map((g) => g.folder)).toEqual(["apps/web/src/map", "apps/api/src", "docs", "/"]);
    expect(groups[0]?.files.map((f) => f.name)).toEqual(["worker-pool.ts", "map-view.tsx"]);
    expect(groups[0]?.files[0]?.status).toBe("added");
    expect(groups[3]?.files.map((f) => f.name)).toEqual(["pnpm-lock.yaml", "old.txt"]);
  });

  it("maps every change kind to a status letter", () => {
    expect(statusOf("copied")).toBe("added");
    expect(statusOf("type-changed")).toBe("modified");
    expect(statusOf("unmerged")).toBe("modified");
    expect(statusOf("renamed")).toBe("renamed");
  });

  it("computes totals, types and largest changes", () => {
    expect(totals(files)).toEqual({
      files: 7,
      additions: 12_831,
      deletions: 242,
      added: 2,
      modified: 4,
      deleted: 1,
      generated: 2,
      tests: 1,
      binary: 1,
    });
    expect(byType(files).slice(0, 3)).toEqual([
      { type: "typescript", count: 3 },
      { type: "images", count: 1 },
      { type: "lockfile", count: 1 },
    ]);
    expect(typeOf("apps/web/src/map/map-view.tsx")).toBe("tsx");
    expect(typeOf("Cargo.lock")).toBe("lockfile");
    expect(typeOf("LICENSE")).toBe("other");
    expect(typeOf("docs/a.b.Md")).toBe("markdown");
    expect(largest(files, 2).map((f) => f.path)).toEqual([
      "apps/api/src/openapi.ts",
      "pnpm-lock.yaml",
    ]);
  });

  it("applies the hide filters", () => {
    const all = { hideGenerated: false, hideLockfiles: false, hideTests: false };
    expect(applyFilters(files, all)).toHaveLength(7);
    expect(applyFilters(files, { ...all, hideLockfiles: true }).map((f) => f.path)).not.toContain(
      "pnpm-lock.yaml",
    );
    const noGenerated = applyFilters(files, { ...all, hideGenerated: true }).map((f) => f.path);
    expect(noGenerated).not.toContain("apps/api/src/openapi.ts");
    expect(noGenerated).toContain("pnpm-lock.yaml");
    expect(applyFilters(files, { ...all, hideTests: true })).toHaveLength(6);
  });
});

describe("pathMatcher, sortBySize and byDirectory", () => {
  const paths = [
    "apps/web/src/map/tile-cache.ts",
    "apps/web/src/map/map-view.test.tsx",
    "packages/core/index.ts",
    "README.md",
  ];

  it("matches a substring without glob characters, case-insensitively", () => {
    const matches = pathMatcher("MAP");
    expect(paths.filter(matches)).toEqual([
      "apps/web/src/map/tile-cache.ts",
      "apps/web/src/map/map-view.test.tsx",
    ]);
    expect(paths.filter(pathMatcher("  "))).toEqual(paths);
  });

  it("matches globs against the name, or the path when the pattern has a slash", () => {
    expect(paths.filter(pathMatcher("*.test.tsx"))).toEqual(["apps/web/src/map/map-view.test.tsx"]);
    expect(paths.filter(pathMatcher("*.ts"))).toEqual([
      "apps/web/src/map/tile-cache.ts",
      "packages/core/index.ts",
    ]);
    expect(paths.filter(pathMatcher("apps/**/*.ts"))).toEqual(["apps/web/src/map/tile-cache.ts"]);
    expect(paths.filter(pathMatcher("apps/*/index.ts"))).toEqual([]);
    expect(paths.filter(pathMatcher("packages/*/index.ts"))).toEqual(["packages/core/index.ts"]);
    expect(paths.filter(pathMatcher("READ??.md"))).toEqual(["README.md"]);
    expect(paths.filter(pathMatcher("[Rr]EADME.md"))).toEqual(["README.md"]);
    // An unbalanced bracket is taken literally rather than throwing.
    expect(paths.filter(pathMatcher("[abc"))).toEqual([]);
  });

  it("sorts by change size and summarises the top folders", () => {
    const files = [
      file("a/one.ts", { additions: 1, deletions: 0 }),
      file("b/two.ts", { additions: 10, deletions: 5 }),
      file("a/three.ts", { additions: 3, deletions: 3 }),
      file("root.ts", { additions: 0, deletions: 0 }),
    ];
    expect(sortBySize(files).map((f) => f.path)).toEqual([
      "b/two.ts",
      "a/three.ts",
      "a/one.ts",
      "root.ts",
    ]);
    expect(byDirectory(files)).toEqual([
      { folder: "a", count: 2 },
      { folder: "/", count: 1 },
      { folder: "b", count: 1 },
    ]);
    expect(byDirectory(files, 1)).toEqual([{ folder: "a", count: 2 }]);
  });
});
