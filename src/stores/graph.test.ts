import type { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommitNode, Ref, WalkFilter, WalkScope } from "@/ipc/schemas";

import { useGraphStore } from "./graph";
import { useRepoStore } from "./repo";
import { useReviewStore } from "./review";
import { useSettingsStore } from "./settings";
import { useShellStore } from "./shell";

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

/**
 * A backend whose walk honours the scope and the filter the way the engine does. `refs` is read
 * on every listing, so a test can move HEAD between two; with `pageSize`, the walk answers one
 * page per request (as many as `walk_continue` asks for after it).
 */
function mockBackend(refs: Ref[] = [], pageSize = 1000): Call[] {
  const calls: Call[] = [];
  const all = Array.from({ length: 30 }, (_, i) => commit(i));
  let walked: CommitNode[] = [];
  const page = (index: number) => ({
    walkId: "w",
    index,
    commits: walked.slice(index * pageSize, (index + 1) * pageSize),
    done: (index + 1) * pageSize >= walked.length,
  });
  /** Pages `from` on, at most `max` of them, as the stream sends them. */
  const pages = (from: number, max: number) => {
    const messages: unknown[] = [];
    for (let index = from; index < from + max; index += 1) {
      const data = page(index);
      messages.push({ kind: "page", seq: index - from, data });
      if (data.done) break;
    }
    messages.push({ kind: "done" });
    return messages;
  };
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
        if (filter.content) listed = listed.filter((_c, i) => i % 3 === 0);
        walked = listed;
        send(args["onPage"] as Channel<unknown>, pages(0, args["maxPages"] as number));
        return null;
      }
      case "walk_continue":
        send(
          args["onPage"] as Channel<unknown>,
          pages(args["nextIndex"] as number, args["maxPages"] as number),
        );
        return null;
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

  it("counts the scope again once the history is listed again, keeping the count meanwhile", async () => {
    const calls = mockBackend();
    const repo = useRepoStore();
    const graph = useGraphStore();
    await repo.open("/r");
    await settled();
    expect(calls.filter((c) => c.cmd === "count_commits")).toHaveLength(1);
    // A commit or a fetch moved a tip: the history lists again, and so does the count.
    repo.reloadWalk();
    expect(graph.total?.count).toBe(30);
    await settled();
    expect(calls.filter((c) => c.cmd === "count_commits")).toHaveLength(2);
    expect(graph.total?.count).toBe(30);
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

  it("walks the branches a pattern matches, again when the refs bring another", async () => {
    const ref = (name: string, kind: Ref["kind"], fullName: string): Ref => ({
      name,
      fullName,
      kind,
      target: commit(0).hash,
      isCurrent: false,
      upstream: null,
      ahead: null,
      behind: null,
      worktree: null,
      message: null,
      committedAt: null,
    });
    const refs = [
      ref("main", "local-branch", "refs/heads/main"),
      ref("claude/fix-auth", "local-branch", "refs/heads/claude/fix-auth"),
      ref("origin/claude/tiles", "remote-branch", "refs/remotes/origin/claude/tiles"),
      ref("claude/v1", "tag", "refs/tags/claude/v1"),
    ];
    const calls = mockBackend(refs);
    const repo = useRepoStore();
    const graph = useGraphStore();
    await repo.open("/r");
    await settled();
    graph.setScope({ kind: "pattern", pattern: "claude/*" });
    await settled();
    const names = ["refs/heads/claude/fix-auth", "refs/remotes/origin/claude/tiles"];
    expect(graph.walkScope).toEqual({ kind: "refs", names });
    expect(graph.patternMatches).toEqual(names);
    expect(graph.isActive).toBe(true);
    const walks = () => calls.filter((c) => c.cmd === "walk_commits");
    expect(walks().at(-1)?.args["scope"]).toEqual({ kind: "refs", names });
    // An agent's new branch joins the walk once the refs are listed again.
    refs.push(ref("claude/new", "local-branch", "refs/heads/claude/new"));
    await repo.refreshRefs();
    await settled();
    expect(walks().at(-1)?.args["scope"]).toEqual({
      kind: "refs",
      names: [
        "refs/heads/claude/fix-auth",
        "refs/remotes/origin/claude/tiles",
        "refs/heads/claude/new",
      ],
    });
  });

  it("walks without the remote branches once they are hidden, and remembers it", async () => {
    const calls = mockBackend();
    const repo = useRepoStore();
    const graph = useGraphStore();
    await repo.open("/r");
    await settled();
    const walks = () => calls.filter((c) => c.cmd === "walk_commits");
    const before = walks().length;
    graph.setHideRemotes(true);
    await settled();
    expect(graph.hideRemotes).toBe(true);
    expect(useSettingsStore().values.graphHideRemotes).toBe(true);
    expect(graph.walkScope).toEqual({ kind: "local" });
    expect(walks()).toHaveLength(before + 1);
    expect(walks().at(-1)?.args["scope"]).toEqual({ kind: "local" });
    // A scope of one branch is the same walk either way.
    graph.setScope({ kind: "current" });
    await settled();
    const scoped = walks().length;
    graph.setHideRemotes(false);
    await settled();
    expect(walks()).toHaveLength(scoped);
  });

  it("opens a repository on the walk without the remote branches while they are hidden", async () => {
    const calls = mockBackend();
    await useSettingsStore().update("graphHideRemotes", true);
    await useRepoStore().open("/r");
    await settled();
    const walks = calls.filter((c) => c.cmd === "walk_commits");
    expect(walks).toHaveLength(1);
    expect(walks[0]?.args["scope"]).toEqual({ kind: "local" });
    expect(useGraphStore().walkScope).toEqual({ kind: "local" });
  });

  it("goes to HEAD's commit, or says the scope leaves it out", async () => {
    const head: Ref = {
      name: "HEAD",
      fullName: "HEAD",
      kind: "head",
      target: commit(5).hash,
      isCurrent: false,
      upstream: null,
      ahead: null,
      behind: null,
      worktree: null,
      message: null,
      committedAt: null,
    };
    const refs = [head];
    mockBackend(refs);
    const repo = useRepoStore();
    const graph = useGraphStore();
    await repo.open("/r");
    await settled();
    expect(await graph.goToHead()).toBe("selected");
    expect(repo.selectedIndex).toBe(5);
    // The current branch's walk (the first ten commits) leaves HEAD out once it moves on.
    refs.splice(0, 1, { ...head, target: commit(20).hash });
    await repo.refreshRefs();
    graph.setScope({ kind: "current" });
    await settled();
    expect(await graph.goToHead()).toBe("outside");
  });

  it("names the remote branches its scope walks, whose badges draw while hidden", async () => {
    const branch = (name: string, kind: "local-branch" | "remote-branch"): Ref => ({
      name,
      fullName: kind === "local-branch" ? `refs/heads/${name}` : `refs/remotes/${name}`,
      kind,
      target: commit(1).hash,
      isCurrent: false,
      upstream: null,
      ahead: null,
      behind: null,
      worktree: null,
      message: null,
      committedAt: null,
    });
    mockBackend([
      branch("claude/a", "local-branch"),
      branch("origin/claude/b", "remote-branch"),
      branch("origin/main", "remote-branch"),
    ]);
    const repo = useRepoStore();
    const graph = useGraphStore();
    await repo.open("/r");
    await settled();
    expect(graph.scopeRemotes).toEqual([]);
    graph.setScope({ kind: "pattern", pattern: "claude/*" });
    expect(graph.scopeRemotes).toEqual(["origin/claude/b"]);
    graph.setScope({ kind: "ref", name: "origin/main", fullName: "refs/remotes/origin/main" });
    expect(graph.scopeRemotes).toEqual(["origin/main"]);
    graph.setScope({ kind: "ref", name: "claude/a", fullName: "refs/heads/claude/a" });
    expect(graph.scopeRemotes).toEqual([]);
  });

  it("loads the pages down to HEAD's date, and no further", async () => {
    const head: Ref = {
      name: "HEAD",
      fullName: "HEAD",
      kind: "head",
      target: commit(12).hash,
      isCurrent: false,
      upstream: null,
      ahead: null,
      behind: null,
      worktree: null,
      message: null,
      committedAt: commit(12).committer.time,
    };
    const refs = [head];
    const calls = mockBackend(refs, 2);
    const repo = useRepoStore();
    const graph = useGraphStore();
    await repo.open("/r");
    await settled();
    const continued = () => calls.filter((c) => c.cmd === "walk_continue").length;
    // A request lists four pages of two: commits 0 to 7 first.
    expect(repo.commits).toHaveLength(8);
    expect(await graph.goToHead()).toBe("selected");
    expect(repo.selectedIndex).toBe(12);
    expect(continued()).toBe(1);
    // HEAD on a commit the walk never lists, dated as commit 12: the search stops once a request
    // lists commits a day older (commit 15), not at the end of the history.
    refs.splice(0, 1, { ...head, target: "f".repeat(40) });
    await repo.refreshRefs();
    await settled();
    graph.setText("commit");
    await settled();
    expect(repo.commits).toHaveLength(8);
    expect(await graph.goToHead()).toBe("outside");
    expect(repo.commits).toHaveLength(16);
  });

  it("gives up when the history lists again before HEAD arrives", async () => {
    const head: Ref = {
      name: "HEAD",
      fullName: "HEAD",
      kind: "head",
      target: commit(25).hash,
      isCurrent: false,
      upstream: null,
      ahead: null,
      behind: null,
      worktree: null,
      message: null,
      committedAt: commit(25).committer.time,
    };
    mockBackend([head], 4);
    const repo = useRepoStore();
    const graph = useGraphStore();
    await repo.open("/r");
    await settled();
    // Commit 25 is three requests away; another filter lists it at once, but this search is over.
    const search = graph.goToHead();
    graph.setText("commit 2");
    expect(await search).toBe("none");
    await settled();
    expect(repo.commits.some((c) => c.hash === commit(25).hash)).toBe(true);
    expect(repo.selectedCommit?.hash).not.toBe(commit(25).hash);
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
    graph.setCode({ text: "retry", lines: false });
    await settled();
    const before = walks();
    graph.clear();
    await settled();
    expect(walks()).toBe(before + 1);
    expect(graph.isActive).toBe(false);
    expect(graph.filters.code).toBeNull();
    expect(graph.matches).toBe(30);
  });

  it("searches the code through the walk's content, the text as written; a blank one clears it", async () => {
    const calls = mockBackend();
    const repo = useRepoStore();
    const graph = useGraphStore();
    await repo.open("/r");
    await settled();
    const walks = () => calls.filter((c) => c.cmd === "walk_commits");
    graph.setCode({ text: " decodeTile(", lines: true });
    await settled();
    expect(graph.isFiltered).toBe(true);
    expect(graph.matches).toBe(10);
    expect(walks().at(-1)?.args["options"]).toEqual({
      pageSize: 500,
      order: "lazy",
      filter: { content: { text: " decodeTile(", lines: true } },
    });
    const before = walks().length;
    // The same search restarts nothing; the choice alone does.
    graph.setCode({ text: " decodeTile(", lines: true });
    expect(walks()).toHaveLength(before);
    graph.setCode({ text: " decodeTile(", lines: false });
    await settled();
    expect(walks()).toHaveLength(before + 1);
    expect(walks().at(-1)?.args["options"]).toMatchObject({
      filter: { content: { text: " decodeTile(", lines: false } },
    });
    // With the path, one walk narrows both.
    graph.setPath("apps/api");
    await settled();
    expect(walks().at(-1)?.args["options"]).toMatchObject({
      filter: { paths: ["apps/api"], content: { text: " decodeTile(", lines: false } },
    });
    // Control characters pasted with the text go, tab aside, and so does what passes 200.
    graph.setPath("");
    graph.setCode({ text: `a\u0001\tb\n${"x".repeat(300)}`, lines: true });
    expect(graph.filters.code).toEqual({ text: `a\tb${"x".repeat(197)}`, lines: true });
    graph.setCode({ text: " \u0000 ", lines: true });
    await settled();
    expect(graph.filters.code).toBeNull();
    expect(graph.isFiltered).toBe(false);
    expect(walks().at(-1)?.args["options"]).not.toHaveProperty("filter");
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

describe("file history", () => {
  it("shows the graph filtered by the path alone, the scope kept", async () => {
    const calls = mockBackend();
    const repo = useRepoStore();
    const graph = useGraphStore();
    const shell = useShellStore();
    await repo.open("/r");
    await settled();
    await shell.setLayoutMode("review");
    graph.setText("fix(auth)");
    graph.setAuthor("iker");
    graph.setDateRange("30d");
    graph.setCode({ text: "retry", lines: false });
    graph.setScope({ kind: "ref", name: "main", fullName: "refs/heads/main" });
    await settled();
    await graph.showHistory("apps/api/src/index.ts");
    await settled();
    expect(graph.filters).toEqual({
      text: "",
      author: "",
      dateRange: "any",
      path: "apps/api/src/index.ts",
      code: null,
      scope: { kind: "ref", name: "main", fullName: "refs/heads/main" },
    });
    expect(shell.layoutMode).toBe("graph");
    const last = calls.filter((c) => c.cmd === "walk_commits").at(-1);
    expect(last?.args["scope"]).toEqual({ kind: "ref", name: "refs/heads/main" });
    expect(last?.args["options"]).toEqual({
      pageSize: 500,
      order: "lazy",
      filter: { paths: ["apps/api/src/index.ts"] },
    });
  });

  it("restarts nothing for the history it shows, and opens nothing for the open repository", async () => {
    const calls = mockBackend();
    const repo = useRepoStore();
    const graph = useGraphStore();
    await repo.open("/r");
    await settled();
    await graph.showHistory("src/a.ts");
    await settled();
    const walks = () => calls.filter((c) => c.cmd === "walk_commits").length;
    const before = walks();
    await graph.showHistory("src/a.ts", "/r/");
    await settled();
    expect(walks()).toBe(before);
    expect(calls.filter((c) => c.cmd === "open_repository")).toHaveLength(1);
    expect(graph.filters.path).toBe("src/a.ts");
  });

  it("takes a file's path as git names it, spaces and backslashes included", async () => {
    const calls = mockBackend();
    const repo = useRepoStore();
    const graph = useGraphStore();
    await repo.open("/r");
    await settled();
    for (const path of [" notes.md", "docs\\a.md"]) {
      await graph.showHistory(path);
      await settled();
      expect(graph.filters.path).toBe(path);
      const last = calls.filter((c) => c.cmd === "walk_commits").at(-1);
      expect((last?.args["options"] as { filter?: unknown }).filter).toEqual({ paths: [path] });
    }
  });

  it("keeps the selected commit in graph focus, and starts on the first row from elsewhere", async () => {
    mockBackend();
    const repo = useRepoStore();
    const graph = useGraphStore();
    const shell = useShellStore();
    await repo.open("/r");
    await settled();
    // Commit 4 is one of the commits the path filter lists.
    repo.select(4);
    await settled();
    const selected = () => repo.commits[repo.selectedIndex]?.hash;
    const fourth = commit(4).hash;
    expect(selected()).toBe(fourth);
    await graph.showHistory("src/a.ts");
    await settled();
    expect(selected()).toBe(fourth);
    await shell.setLayoutMode("review");
    await graph.showHistory("src/b.ts");
    await settled();
    expect(repo.selectedIndex).toBe(0);
    expect(selected()).toBe(commit(0).hash);
  });
});
