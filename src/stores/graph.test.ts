import type { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommitNode, Ref, WalkFilter, WalkScope } from "@/ipc/schemas";

import { useGraphStore } from "./graph";
import { useRepoStore } from "./repo";
import { useReviewStore } from "./review";

const authorsOf = ["iker", "claude", "ane"] as const;

/** 30 commits: subjects "commit N", authors cycling, one day apart, half of them under apps/api. */
function commit(n: number): CommitNode {
  const name = authorsOf[n % 3] ?? "iker";
  const who = { name, email: `${name}@x`, time: 1_700_000_000 - n * 86_400, offsetMinutes: 0 };
  return {
    hash: n.toString(16).padStart(40, "0"),
    parents: [(n + 1).toString(16).padStart(40, "0")],
    author: who,
    committer: who,
    subject: n % 5 === 0 ? `fix(auth): commit ${n}` : `commit ${n}`,
    body: "",
    refs: [],
    lane: n % 3,
    edges: [],
    overflow: 0,
  };
}

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

/** A backend whose walk honours the scope and the filter the way the engine does. */
/** `refs` is read on every listing, so a test can move HEAD between two. */
function mockBackend(refs: Ref[] = []): Call[] {
  const calls: Call[] = [];
  const all = Array.from({ length: 30 }, (_, i) => commit(i));
  const send = (channel: Channel<unknown>, messages: unknown[]) => {
    queueMicrotask(() => {
      for (const message of messages) channel.onmessage(message);
    });
  };
  mockIPC((cmd, rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "open_repository":
        return {
          root: "/r",
          commonDir: "/r/.git",
          currentBranch: "main",
          detached: false,
          isLinkedWorktree: false,
        };
      case "list_refs":
        return refs.map((entry) => ({ ...entry }));
      case "walk_commits": {
        const scope = args["scope"] as WalkScope;
        const filter = (args["options"] as { filter?: WalkFilter }).filter ?? {};
        let listed = scope.kind === "ref" ? all.slice(0, 10) : all;
        if (filter.text) listed = listed.filter((c) => c.subject.includes(filter.text ?? ""));
        if (filter.author) listed = listed.filter((c) => c.author.name === filter.author);
        if (filter.since !== undefined) {
          listed = listed.filter((c) => c.author.time >= (filter.since ?? 0));
        }
        if (filter.paths) listed = listed.filter((_c, i) => i % 2 === 0);
        send(args["onPage"] as Channel<unknown>, [
          { kind: "page", seq: 0, data: { walkId: "w", index: 0, commits: listed, done: true } },
          { kind: "done" },
        ]);
        return null;
      }
      case "count_commits": {
        const scope = args["scope"] as WalkScope;
        return { count: scope.kind === "ref" ? 10 : 30, capped: false };
      }
      case "diff":
        send(args["onPage"] as Channel<unknown>, [
          {
            kind: "page",
            seq: 0,
            data: { additions: 0, deletions: 0, totalFiles: 0, files: [] },
          },
          { kind: "done" },
        ]);
        return null;
      case "close_repository":
      case "close_walk":
      case "cancel_operation":
        return true;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  });
  return calls;
}

async function settled(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_700_000_000 * 1000);
});

afterEach(() => {
  clearMocks();
  vi.useRealTimers();
});

describe("graph store", () => {
  it("starts unfiltered, counts the scope after the first page and lists the authors seen", async () => {
    const calls = mockBackend();
    const repo = useRepoStore();
    const graph = useGraphStore();
    await repo.open("/r");
    await settled();
    expect(graph.isFiltered).toBe(false);
    expect(graph.isActive).toBe(false);
    expect(graph.matches).toBe(30);
    expect(graph.total).toEqual({ count: 30, capped: false });
    expect(graph.authorList.map((a) => a.name)).toEqual(["ane", "claude", "iker"]);
    expect(graph.authorList[0]).toEqual({ name: "ane", email: "ane@x", count: 10 });
    // One count per scope, after the walk started.
    const order = calls.map((c) => c.cmd);
    expect(order.indexOf("count_commits")).toBeGreaterThan(order.indexOf("walk_commits"));
    expect(calls.filter((c) => c.cmd === "count_commits")).toHaveLength(1);
  });

  it("text, author, date and path restart the walk with the engine's filter", async () => {
    const calls = mockBackend();
    const repo = useRepoStore();
    const graph = useGraphStore();
    await repo.open("/r");
    await settled();
    graph.setText("  fix(auth) ");
    await settled();
    expect(graph.isFiltered).toBe(true);
    expect(graph.matches).toBe(6);
    expect(repo.commits.every((c) => c.subject.startsWith("fix(auth)"))).toBe(true);
    graph.setAuthor("iker");
    await settled();
    expect(graph.matches).toBe(2);
    graph.setDateRange("7d");
    await settled();
    expect(graph.matches).toBe(1);
    graph.setPath("apps\\api\\");
    await settled();
    expect(graph.filters.path).toBe("apps/api");
    const last = calls.filter((c) => c.cmd === "walk_commits").at(-1);
    expect(last?.args["options"]).toEqual({
      pageSize: 500,
      order: "lazy",
      filter: {
        text: "fix(auth)",
        author: "iker",
        since: 1_700_000_000 - 7 * 86_400,
        paths: ["apps/api"],
      },
    });
    // The filters never recount the scope: the total stays the scope's.
    expect(calls.filter((c) => c.cmd === "count_commits")).toHaveLength(1);
    expect(graph.total?.count).toBe(30);
    // The authors seen keep every author of the repository, not only the filtered ones.
    expect(graph.authorList).toHaveLength(3);
  });

  it("the scope walks the branch and is counted once; the same walk is not restarted", async () => {
    const calls = mockBackend();
    const repo = useRepoStore();
    const graph = useGraphStore();
    await repo.open("/r");
    await settled();
    graph.setScope({ kind: "current" });
    await settled();
    expect(graph.isActive).toBe(true);
    expect(graph.isFiltered).toBe(false);
    expect(graph.walkScope).toEqual({ kind: "ref", name: "main" });
    expect(graph.matches).toBe(10);
    expect(graph.total).toEqual({ count: 10, capped: false });
    const walks = () => calls.filter((c) => c.cmd === "walk_commits").length;
    const before = walks();
    graph.setScope({ kind: "ref", name: "main", fullName: "main" });
    await settled();
    expect(walks()).toBe(before);
    expect(graph.filters.scope).toEqual({ kind: "ref", name: "main", fullName: "main" });
    graph.setScope({ kind: "ref", name: "develop", fullName: "refs/heads/develop" });
    await settled();
    expect(walks()).toBe(before + 1);
    expect(calls.filter((c) => c.cmd === "count_commits")).toHaveLength(3);
  });

  it("walks the new branch when HEAD switches while the scope is the current branch", async () => {
    const branch = (name: string, isCurrent: boolean): Ref => ({
      name,
      fullName: `refs/heads/${name}`,
      kind: "local-branch",
      target: commit(0).hash,
      isCurrent,
      upstream: null,
      ahead: null,
      behind: null,
      worktree: null,
      message: null,
      committedAt: null,
    });
    const refs = [branch("develop", false), branch("main", true)];
    const calls = mockBackend(refs);
    const repo = useRepoStore();
    const graph = useGraphStore();
    await repo.open("/r");
    await settled();
    const walks = () => calls.filter((c) => c.cmd === "walk_commits");
    graph.setScope({ kind: "current" });
    await settled();
    const before = walks().length;
    // `git switch develop` in a terminal (both branches on one commit: no tip moves).
    refs.splice(0, refs.length, branch("develop", true), branch("main", false));
    await repo.refreshRefs();
    await settled();
    expect(graph.walkScope).toEqual({ kind: "ref", name: "develop" });
    expect(walks()).toHaveLength(before + 1);
    expect(walks().at(-1)?.args["scope"]).toEqual({ kind: "ref", name: "develop" });
    // With every branch shown, a switch lists nothing again.
    graph.setScope({ kind: "all" });
    await settled();
    const all = walks().length;
    refs.splice(0, refs.length, branch("develop", false), branch("main", true));
    await repo.refreshRefs();
    await settled();
    expect(walks()).toHaveLength(all);
  });

  it("clear resets every control and restarts once", async () => {
    const calls = mockBackend();
    const repo = useRepoStore();
    const graph = useGraphStore();
    await repo.open("/r");
    await settled();
    graph.clear();
    const walks = () => calls.filter((c) => c.cmd === "walk_commits").length;
    expect(walks()).toBe(1);
    graph.setText("commit 1");
    graph.setScope({ kind: "current" });
    await settled();
    const before = walks();
    graph.clear();
    await settled();
    expect(walks()).toBe(before + 1);
    expect(graph.isActive).toBe(false);
    expect(graph.matches).toBe(30);
  });

  it("pins the diff base and the range end in the review store and drops them with the repository", async () => {
    mockBackend();
    const repo = useRepoStore();
    const graph = useGraphStore();
    const review = useReviewStore();
    await repo.open("/r");
    await settled();
    graph.setDiffBase(commit(3).hash);
    graph.setRangeEnd(commit(5).hash);
    expect(review.diffBase).toBe(commit(3).hash);
    expect(graph.diffBase).toBe(commit(3).hash);
    expect(graph.rangeEnd).toBe(commit(5).hash);
    graph.setDiffBase(null);
    expect(graph.diffBase).toBeNull();
    graph.setText("commit");
    await repo.open("/r2");
    await settled();
    expect(graph.rangeEnd).toBeNull();
    expect(graph.filters.text).toBe("");
    expect(graph.isActive).toBe(false);
  });
});
