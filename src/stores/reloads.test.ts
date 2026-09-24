import { describe, expect, it } from "vitest";

import type { ChangeKind, FileChange, RepoChanged } from "@/ipc/schemas";
import {
  comparePaths,
  covers,
  MAX_RESTRICTED_PATHS,
  mergeReloads,
  mergeRestricted,
  reloadFor,
  Reloader,
  requestedPaths,
} from "./reloads";

function file(path: string, status: ChangeKind = "modified", oldPath: string | null = null) {
  const change: FileChange = {
    status,
    path,
    oldPath,
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
    newId: `id-${path}`,
  };
  return change;
}

function change(partial: Partial<RepoChanged>): RepoChanged {
  return {
    repo: "/r",
    kinds: [],
    paths: [],
    indexPaths: null,
    conflictsChanged: false,
    ...partial,
  };
}

const paths = (files: FileChange[]) => files.map((f) => f.path);

describe("covers", () => {
  it("covers a path, what is below it and the entries above it", () => {
    expect(covers("src/a.rs", "src/a.rs")).toBe(true);
    expect(covers("src", "src/a.rs")).toBe(true);
    expect(covers("src/", "src/a.rs")).toBe(true);
    expect(covers("nested/x.txt", "nested/")).toBe(true);
    expect(covers("sub/s.txt", "sub")).toBe(true);
    expect(covers("docs", "docs2/b.txt")).toBe(false);
    expect(covers("docs2", "docs/a.txt")).toBe(false);
    expect(covers("src/a.rs", "src/a.rs.bak")).toBe(false);
    expect(covers("src/a", "src/ab/c.rs")).toBe(false);
  });
});

describe("comparePaths", () => {
  it("orders by code point, as the engine's bytes", () => {
    const sorted = ["z.txt", "README.md", "é.txt", "a/b", "a-b", "😀.txt", "�.txt"].sort(
      comparePaths,
    );
    expect(sorted).toEqual(["README.md", "a-b", "a/b", "z.txt", "é.txt", "�.txt", "😀.txt"]);
  });
});

describe("mergeRestricted", () => {
  it("replaces what the paths cover and keeps the engine's order", () => {
    const before = [file("README.md"), file("docs/a.md"), file("src/a.rs"), file("src/b.rs")];
    const merged = mergeRestricted(before, ["src"], [file("src/b.rs"), file("src/c.rs", "added")]);
    expect(paths(merged)).toEqual(["README.md", "docs/a.md", "src/b.rs", "src/c.rs"]);
    expect(merged.find((f) => f.path === "src/c.rs")?.status).toBe("added");
  });

  it("drops a file restored to the index and a rename whose old side is covered", () => {
    const before = [file("a.txt"), file("new.rs", "renamed", "old.rs"), file("z.txt")];
    expect(paths(mergeRestricted(before, ["a.txt"], []))).toEqual(["new.rs", "z.txt"]);
    expect(paths(mergeRestricted(before, ["old.rs"], []))).toEqual(["a.txt", "z.txt"]);
  });

  it("gives the same list as a full reload when the change stayed under the paths", () => {
    const before = [file("a.txt"), file("dir/x"), file("nested/"), file("sub"), file("z.txt")];
    const cases: { changed: string[]; after: FileChange[] }[] = [
      {
        changed: ["dir/y"],
        after: [
          file("a.txt"),
          file("dir/x"),
          file("dir/y", "added"),
          file("nested/"),
          file("sub"),
          file("z.txt"),
        ],
      },
      { changed: ["a.txt"], after: [file("dir/x"), file("nested/"), file("sub"), file("z.txt")] },
      {
        changed: ["nested/inner.txt"],
        after: [file("a.txt"), file("dir/x"), file("sub"), file("z.txt")],
      },
      {
        changed: ["sub/s.txt"],
        after: [file("a.txt"), file("dir/x"), file("nested/"), file("z.txt")],
      },
      { changed: ["dir"], after: [file("a.txt"), file("nested/"), file("sub"), file("z.txt")] },
    ];
    for (const { changed, after } of cases) {
      const requested = requestedPaths(before, changed, false);
      const fresh = after.filter((f) => requested.some((path) => covers(path, f.path)));
      expect(paths(mergeRestricted(before, requested, fresh)), changed.join()).toEqual(
        paths(after),
      );
    }
  });
});

describe("requestedPaths", () => {
  const listed = [
    file("gone.rs", "deleted"),
    file("nested/"),
    file("new.rs", "renamed", "old.rs"),
    file("plain.txt"),
    file("sub"),
  ];

  it("adds the listed entries a path touches", () => {
    expect(requestedPaths(listed, ["nested/x.txt"], false).sort()).toEqual([
      "nested",
      "nested/x.txt",
    ]);
    expect(requestedPaths(listed, ["sub/s.txt"], false).sort()).toEqual(["sub", "sub/s.txt"]);
    expect(requestedPaths(listed, ["new.rs"], false).sort()).toEqual(["new.rs", "old.rs"]);
  });

  it("adds every listed addition and deletion for a list that pairs renames", () => {
    expect(requestedPaths(listed, ["plain.txt"], true).sort()).toEqual(["gone.rs", "plain.txt"]);
    expect(requestedPaths(listed, ["plain.txt"], false)).toEqual(["plain.txt"]);
  });
});

describe("reloadFor", () => {
  it("reads the working tree's paths and the index entries", () => {
    expect(reloadFor(change({ kinds: ["status"], paths: ["a.txt"] }), true)).toEqual({
      kind: "paths",
      paths: ["a.txt"],
    });
    expect(reloadFor(change({ kinds: ["status"], paths: ["a.txt"] }), false)).toEqual({
      kind: "none",
    });
    expect(
      reloadFor(
        change({ kinds: ["index", "status"], paths: ["a.txt"], indexPaths: ["b.txt"] }),
        true,
      ),
    ).toEqual({ kind: "paths", paths: ["a.txt", "b.txt"] });
    expect(reloadFor(change({ kinds: ["index"], indexPaths: [] }), true)).toEqual({ kind: "none" });
    expect(reloadFor(change({ kinds: ["refs"] }), true)).toEqual({ kind: "none" });
  });

  it("reloads in full when the paths cannot say enough", () => {
    expect(reloadFor(change({ kinds: ["status"], paths: [] }), true)).toEqual({ kind: "full" });
    expect(reloadFor(change({ kinds: ["index"], indexPaths: null }), false)).toEqual({
      kind: "full",
    });
    expect(reloadFor(change({ kinds: ["status"], paths: ["web/.gitignore"] }), true)).toEqual({
      kind: "full",
    });
    const many = Array.from({ length: MAX_RESTRICTED_PATHS + 1 }, (_, i) => `f${i}`);
    expect(reloadFor(change({ kinds: ["status"], paths: many }), true)).toEqual({ kind: "full" });
  });
});

describe("mergeReloads", () => {
  it("lets a full reload absorb the rest and joins paths", () => {
    expect(mergeReloads(null, { kind: "paths", paths: ["a"] })).toEqual({
      kind: "paths",
      paths: ["a"],
    });
    expect(
      mergeReloads({ kind: "paths", paths: ["a"] }, { kind: "paths", paths: ["a", "b"] }),
    ).toEqual({
      kind: "paths",
      paths: ["a", "b"],
    });
    expect(mergeReloads({ kind: "paths", paths: ["a"] }, { kind: "full" })).toEqual({
      kind: "full",
    });
  });
});

/** A runner whose runs finish when the test says so. */
function controlled() {
  const log: string[] = [];
  const finish: (() => void)[] = [];
  let listed = true;
  const runners = {
    full: () =>
      new Promise<void>((resolve) => {
        log.push("full");
        finish.push(resolve);
      }),
    paths: (requested: string[]) =>
      new Promise<boolean>((resolve) => {
        log.push(`paths:${requested.join(",")}`);
        finish.push(() => resolve(listed));
      }),
  };
  return {
    log,
    runners,
    tooMany: () => {
      listed = false;
    },
    finishNext: async () => {
      finish.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("Reloader", () => {
  it("runs one reload at a time and merges what waits", async () => {
    const control = controlled();
    const reloader = new Reloader(control.runners);
    reloader.request({ kind: "paths", paths: ["a"] });
    reloader.request({ kind: "paths", paths: ["b"] });
    reloader.request({ kind: "paths", paths: ["c"] });
    expect(control.log).toEqual(["paths:a"]);
    await control.finishNext();
    expect(control.log).toEqual(["paths:a", "paths:b,c"]);
    await control.finishNext();
    await reloader.settled();
  });

  it("starts a full reload at once and runs later paths after it", async () => {
    const control = controlled();
    const reloader = new Reloader(control.runners);
    reloader.request({ kind: "paths", paths: ["a"] });
    reloader.request({ kind: "full" });
    reloader.request({ kind: "paths", paths: ["b"] });
    expect(control.log).toEqual(["paths:a", "full"]);
    await control.finishNext();
    await control.finishNext();
    expect(control.log).toEqual(["paths:a", "full", "paths:b"]);
    await control.finishNext();
  });

  it("holds requests while a write runs", async () => {
    const control = controlled();
    const reloader = new Reloader(control.runners);
    reloader.hold();
    reloader.request({ kind: "paths", paths: ["a"] });
    reloader.request({ kind: "full" });
    expect(control.log).toEqual([]);
    reloader.resume();
    expect(control.log).toEqual(["full"]);
    await control.finishNext();
  });

  it("reloads in full when a restricted reload lists too many files", async () => {
    const control = controlled();
    control.tooMany();
    const reloader = new Reloader(control.runners);
    reloader.request({ kind: "paths", paths: ["many"] });
    await control.finishNext();
    expect(control.log).toEqual(["paths:many", "full"]);
    await control.finishNext();
  });
});
