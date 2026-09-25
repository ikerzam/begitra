import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RepoChanged } from "@/ipc/schemas";
import { repoChange } from "@/test/changes";

import { mergeChanges, Pacer } from "./pace";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mergeChanges", () => {
  it("joins the kinds and the paths each change named", () => {
    const merged = mergeChanges(
      repoChange({ kinds: ["status"], paths: ["a.ts"] }),
      repoChange({ kinds: ["status", "index"], paths: ["b.ts"], indexPaths: ["b.ts"] }),
    );
    expect(merged.kinds).toEqual(["status", "index"]);
    expect(merged.paths).toEqual(["a.ts", "b.ts"]);
    expect(merged.indexPaths).toEqual(["b.ts"]);
  });

  it("stays unknown where one side could not name its paths or entries", () => {
    const merged = mergeChanges(
      repoChange({ kinds: ["status"], paths: [] }),
      repoChange({ kinds: ["status", "index"], paths: ["b.ts"], indexPaths: null }),
    );
    expect(merged.paths).toEqual([]);
    expect(merged.indexPaths).toBeNull();
    expect(
      mergeChanges(
        repoChange({ kinds: ["index"], indexPaths: [], conflictsChanged: true }),
        repoChange({ kinds: ["refs"], paths: ["refs/heads/main"] }),
      ),
    ).toMatchObject({ indexPaths: [], conflictsChanged: true });
  });
});

describe("Pacer", () => {
  it("applies a repository's first change at once and the next ones merged, a period later", () => {
    const applied: RepoChanged[] = [];
    const pacer = new Pacer(1000, (change) => applied.push(change));
    pacer.push(repoChange({ repo: "/api", kinds: ["status"], paths: ["a.ts"] }));
    expect(applied).toHaveLength(1);
    pacer.push(repoChange({ repo: "/api", kinds: ["status"], paths: ["b.ts"] }));
    pacer.push(repoChange({ repo: "/api", kinds: ["status"], paths: ["c.ts"] }));
    // Another repository keeps its own pace.
    pacer.push(repoChange({ repo: "/web", kinds: ["status"], paths: ["w.ts"] }));
    expect(applied.map((change) => change.repo)).toEqual(["/api", "/web"]);
    vi.advanceTimersByTime(999);
    expect(applied).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(applied).toHaveLength(3);
    expect(applied[2]).toMatchObject({ repo: "/api", paths: ["b.ts", "c.ts"] });
    // A second later again, the next change applies at once.
    vi.advanceTimersByTime(1000);
    pacer.push(repoChange({ repo: "/api", kinds: ["status"], paths: ["d.ts"] }));
    expect(applied).toHaveLength(4);
  });

  it("drops what waits when cleared", () => {
    const applied: RepoChanged[] = [];
    const pacer = new Pacer(1000, (change) => applied.push(change));
    pacer.push(repoChange({ repo: "/api", kinds: ["status"], paths: ["a.ts"] }));
    pacer.push(repoChange({ repo: "/api", kinds: ["status"], paths: ["b.ts"] }));
    pacer.clear();
    vi.advanceTimersByTime(5000);
    expect(applied).toHaveLength(1);
    pacer.push(repoChange({ repo: "/api", kinds: ["status"], paths: ["c.ts"] }));
    expect(applied).toHaveLength(2);
  });
});
