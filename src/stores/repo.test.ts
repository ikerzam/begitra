import type { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CommitNode, Ref as GitRef, Repo } from "@/ipc/schemas";
import { armed } from "@/motion/motion";

import { useOperationsStore } from "./operations";
import { headState, tipsSignature, useRepoStore } from "./repo";

const repo: Repo = {
  root: "/r",
  commonDir: "/r/.git",
  currentBranch: "main",
  detached: false,
  isLinkedWorktree: false,
};

function commit(n: number): CommitNode {
  const who = { name: "a", email: "a@x", time: 1_700_000_000 - n, offsetMinutes: 0 };
  return {
    hash: n.toString(16).padStart(40, "0"),
    parents: [(n + 1).toString(16).padStart(40, "0")],
    author: who,
    committer: who,
    subject: `commit ${n}`,
    body: "",
    refs: [],
    lane: 0,
    edges: [],
    overflow: 0,
  };
}

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

/** A fake backend with 1,200 commits served in pages of 500 and one file per diff. */
interface BackendOptions {
  openFails?: boolean;
  /** `list_refs` rejects. */
  refsFail?: boolean;
  /** `walk_continue` rejects with `op.unknown_walk` until a new `walk_commits` ran. */
  loseWalk?: boolean;
  /** Diff pages are delivered only after this promise resolves. */
  diffGate?: Promise<void>;
  /** `open_repository` resolves only after this promise resolves. */
  openGate?: Promise<void>;
  /** Walk pages are delivered only after this promise resolves. */
  walkGate?: Promise<void>;
  /** The walks after the open's deliver their pages only after this promise resolves. */
  reloadGate?: Promise<void>;
  /** The walks after the open's fail before their first page. */
  reloadFails?: boolean;
  /** The next `list_refs` answers the refs as they were when asked, once this resolves. */
  refsGate?: Promise<void>;
  /** What `list_refs` answers instead of the one `main`. */
  refs?: GitRef[];
}

function mockBackend(options: BackendOptions = {}): Call[] {
  const calls: Call[] = [];
  const total = 1_200;
  let walks = 0;
  const send = (channel: Channel<unknown>, messages: unknown[], gate?: Promise<void>) => {
    const deliver = () => {
      for (const message of messages) channel.onmessage(message);
    };
    if (gate) void gate.then(deliver);
    else queueMicrotask(deliver);
  };
  mockIPC((cmd, rawArgs) => {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    calls.push({ cmd, args });
    switch (cmd) {
      case "open_repository":
        if (options.openFails) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Tauri rejects with the serialised AppError object
          return Promise.reject({
            code: "repo.not_found",
            message: "No Git repository found at or above /r",
          });
        }
        if (options.openGate) return options.openGate.then(() => repo);
        return repo;
      case "list_refs":
        if (options.refsFail) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
          return Promise.reject({ code: "internal", message: "refs exploded" });
        }
        if (options.refs) {
          const listed = options.refs.map((entry) => ({ ...entry }));
          const gate = options.refsGate;
          options.refsGate = undefined;
          return gate ? gate.then(() => listed) : listed;
        }
        return [
          {
            name: "main",
            fullName: "refs/heads/main",
            kind: "local-branch",
            target: commit(0).hash,
            isCurrent: true,
            upstream: null,
            ahead: null,
            behind: null,
            worktree: "/r",
            message: null,
            committedAt: commit(0).committer.time,
          },
        ];
      case "walk_commits":
      case "walk_continue": {
        if (cmd === "walk_commits") walks += 1;
        if (cmd === "walk_continue" && options.loseWalk && walks < 2) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
          return Promise.reject({ code: "op.unknown_walk", message: "Walk walk-1 is not open" });
        }
        if (cmd === "walk_commits" && walks > 1 && options.reloadFails) {
          send(args["onPage"] as Channel<unknown>, [
            {
              kind: "error",
              error: { code: "repo.corrupt_object", message: "object 6c1f0ab is missing" },
            },
          ]);
          return null;
        }
        const first = cmd === "walk_commits" ? 0 : (args["nextIndex"] as number);
        const maxPages = args["maxPages"] as number;
        // A ref scope lists the first three commits; a text filter keeps the subjects holding it.
        const scope = args["scope"] as { kind: string } | undefined;
        const walkOptions = args["options"] as { filter?: { text?: string } } | undefined;
        const text = walkOptions?.filter?.text;
        const listed = Array.from({ length: scope?.kind === "ref" ? 3 : total }, (_, i) =>
          commit(i),
        ).filter((c) => text === undefined || c.subject.includes(text));
        const messages: unknown[] = [];
        let seq = 0;
        if (listed.length === 0) {
          // Nothing matches: the engine still answers one empty, done page.
          messages.push({
            kind: "page",
            seq,
            data: { walkId: `walk-${walks}`, index: 0, commits: [], done: true },
          });
          seq += 1;
        }
        for (let index = first; index < first + maxPages; index += 1) {
          const start = index * 500;
          if (start >= listed.length) break;
          const commits = listed.slice(start, start + 500);
          const done = start + commits.length >= listed.length;
          const walkId = `walk-${walks}`;
          messages.push({ kind: "page", seq, data: { walkId, index, commits, done } });
          seq += 1;
          if (done) break;
        }
        messages.push({ kind: "done" });
        // Filtered walks wait on the gate, a reload on its own; the plain walk of an open never does.
        send(
          args["onPage"] as Channel<unknown>,
          messages,
          walkOptions?.filter ? options.walkGate : walks > 1 ? options.reloadGate : undefined,
        );
        return null;
      }
      case "diff": {
        const target = args["target"] as { hash: string };
        send(
          args["onPage"] as Channel<unknown>,
          [
            {
              kind: "page",
              seq: 0,
              data: {
                additions: 3,
                deletions: 1,
                totalFiles: 1,
                files: [
                  {
                    status: "modified",
                    path: `file-${target.hash.slice(-2)}.rs`,
                    oldPath: null,
                    similarity: null,
                    additions: 3,
                    deletions: 1,
                    hunks: [],
                    isBinary: false,
                    isLarge: false,
                    isGenerated: false,
                    isTest: false,
                    isLossy: false,
                    oldId: null,
                    newId: null,
                  },
                ],
              },
            },
            { kind: "done" },
          ],
          options.diffGate,
        );
        return null;
      }
      case "close_repository":
        return true;
      case "close_walk":
        return true;
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
});

afterEach(() => {
  clearMocks();
});

describe("repo store", () => {
  it("opens a repository, streams the first pages, selects the first commit and loads its files", async () => {
    const calls = mockBackend();
    const store = useRepoStore();
    const operations = useOperationsStore();
    expect(store.state.kind).toBe("empty");
    const opening = store.open("/r");
    expect(store.state).toEqual({ kind: "opening", path: "/r" });
    expect(operations.isBusy).toBe(true);
    await opening;
    await settled();
    expect(store.state.kind).toBe("ready");
    expect(store.repo?.root).toBe("/r");
    expect(store.refs).toHaveLength(1);
    expect(store.currentBranch?.name).toBe("main");
    expect(store.commits).toHaveLength(1_200);
    expect(store.walk).toEqual({ walkId: "walk-1", nextIndex: 3, done: true, skipBefore: 0 });
    expect(store.streaming).toBe(false);
    expect(store.canLoadMore).toBe(false);
    expect(store.selectedIndex).toBe(0);
    expect(store.detail?.loading).toBe(false);
    expect(store.detail?.files.map((f) => f.path)).toEqual(["file-00.rs"]);
    expect(operations.isBusy).toBe(false);
    // The walk starts before the refs are listed so the first page never waits for them.
    expect(calls.map((c) => c.cmd)).toEqual([
      "open_repository",
      "walk_commits",
      "list_refs",
      "diff",
    ]);
  });

  it("selecting another row loads its change set and cancels the previous one", async () => {
    const calls = mockBackend();
    const store = useRepoStore();
    await store.open("/r");
    await settled();
    store.select(2);
    store.select(3);
    await settled();
    expect(store.selectedCommit?.subject).toBe("commit 3");
    expect(store.detail?.hash).toBe(commit(3).hash);
    expect(store.detail?.files.map((f) => f.path)).toEqual(["file-03.rs"]);
    const diffs = calls.filter((c) => c.cmd === "diff");
    expect(diffs).toHaveLength(3);
    expect(calls.some((c) => c.cmd === "cancel_operation")).toBe(true);
    store.select(9_999);
    expect(store.selectedIndex).toBe(3);
  });

  it("continues the walk on demand", async () => {
    const calls = mockBackend();
    const store = useRepoStore();
    // Ask for one page at a time by continuing with the store's page budget after a first page.
    await store.open("/r");
    await settled();
    expect(store.walk?.done).toBe(true);
    store.loadMore();
    expect(calls.filter((c) => c.cmd === "walk_continue")).toHaveLength(0);
    store.walk = { walkId: "walk-1", nextIndex: 1, done: false, skipBefore: 0 };
    store.loadMore();
    await settled();
    const cont = calls.find((c) => c.cmd === "walk_continue");
    expect(cont?.args).toMatchObject({ walkId: "walk-1", nextIndex: 1, maxPages: 4 });
    expect(store.walk?.done).toBe(true);
  });

  it("reports an error state with the code when the folder is not a repository", async () => {
    mockBackend({ openFails: true });
    const store = useRepoStore();
    await store.open("/r");
    expect(store.state.kind).toBe("error");
    if (store.state.kind === "error") {
      expect(store.state.error.code).toBe("repo.not_found");
      expect(store.state.path).toBe("/r");
    }
    expect(useOperationsStore().isBusy).toBe(false);
  });

  it("closes and returns to the empty shell", async () => {
    const calls = mockBackend();
    const store = useRepoStore();
    await store.open("/r");
    await settled();
    await store.close();
    expect(store.state.kind).toBe("empty");
    expect(store.commits).toHaveLength(0);
    expect(store.repo).toBeNull();
    expect(calls.some((c) => c.cmd === "close_repository" && c.args["root"] === "/r")).toBe(true);
  });
});

describe("repo store, refs from git's answer", () => {
  function ref(name: string, kind: GitRef["kind"], target = commit(0).hash): GitRef {
    const prefix = kind === "tag" ? "refs/tags/" : kind === "stash" ? "" : "refs/heads/";
    return {
      name,
      fullName: kind === "stash" ? "refs/stash" : `${prefix}${name}`,
      kind,
      target,
      isCurrent: name === "main",
      upstream: null,
      ahead: null,
      behind: null,
      worktree: null,
      message: null,
      committedAt: null,
    };
  }

  it("shows a deleted branch or tag, a renamed branch and a dropped stash at once", async () => {
    mockBackend({
      refs: [
        ref("main", "local-branch"),
        ref("feature/x", "local-branch"),
        ref("v1", "tag"),
        ref("stash@{0}", "stash", "a".repeat(40)),
        ref("stash@{1}", "stash", "b".repeat(40)),
        ref("stash@{2}", "stash", "c".repeat(40)),
      ],
    });
    const store = useRepoStore();
    await store.open("/r");
    await settled();
    store.patchRefs({ kind: "delete", fullName: "refs/heads/feature/x" });
    store.patchRefs({ kind: "delete", fullName: "refs/tags/v1" });
    store.patchRefs({
      kind: "rename",
      fullName: "refs/heads/main",
      name: "trunk",
      newFullName: "refs/heads/trunk",
    });
    store.patchRefs({ kind: "drop-stash", hash: "b".repeat(40) });
    expect(store.refs.map((entry) => [entry.name, entry.fullName, entry.target])).toEqual([
      ["trunk", "refs/heads/trunk", commit(0).hash],
      ["stash@{0}", "refs/stash", "a".repeat(40)],
      ["stash@{1}", "refs/stash", "c".repeat(40)],
    ]);
    // A stash the refs no longer list changes nothing.
    store.patchRefs({ kind: "drop-stash", hash: "d".repeat(40) });
    expect(store.refs).toHaveLength(3);
  });

  it("arms the motion a listing asked for when another listing is the one stored", async () => {
    const options: BackendOptions = { refs: [ref("main", "local-branch")] };
    mockBackend(options);
    const store = useRepoStore();
    await store.open("/r");
    await settled();
    let release!: () => void;
    options.refsGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The create's listing waits; the watcher's, asked later, lands and is stored.
    const created = store.refreshRefs({ arm: "branches" });
    options.refs = [ref("main", "local-branch"), ref("feature/new", "local-branch")];
    await store.refreshRefs();
    expect(armed("branches")).toBe(true);
    release();
    await created;
  });

  it("keeps what a later listing read over an earlier one that lands after it", async () => {
    const options: BackendOptions = {
      refs: [ref("main", "local-branch"), ref("feature/x", "local-branch")],
    };
    mockBackend(options);
    const store = useRepoStore();
    await store.open("/r");
    await settled();
    let release!: () => void;
    options.refsGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Read before git deleted the branch, this listing lands last.
    const early = store.refreshRefs();
    options.refs = [ref("main", "local-branch")];
    store.patchRefs({ kind: "delete", fullName: "refs/heads/feature/x" });
    await store.refreshRefs();
    release();
    await early;
    expect(store.refs.map((entry) => entry.name)).toEqual(["main"]);
  });
});

describe("repo store, reloaded walks", () => {
  it("keeps the rows and the selection until the reloaded history's first page replaces them", async () => {
    let open!: () => void;
    const reloadGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const calls = mockBackend({ reloadGate });
    const store = useRepoStore();
    await store.open("/r");
    await settled();
    store.select(2);
    await settled();
    const before = store.commits;
    store.reloadWalk();
    await settled();
    // No skeleton rows: the rows and the selection stay while the history is listed again.
    expect(store.commits).toBe(before);
    expect(store.selectedIndex).toBe(2);
    expect(store.reloading).toBe(true);
    open();
    await settled();
    expect(store.reloading).toBe(false);
    expect(calls.filter((c) => c.cmd === "walk_commits")).toHaveLength(2);
    expect(store.commits).not.toBe(before);
    expect(store.commits).toHaveLength(before.length);
    expect(store.selectedIndex).toBe(2);
    expect(store.detail?.hash).toBe(commit(2).hash);
  });

  it("selects the commit the reload names", async () => {
    mockBackend();
    const store = useRepoStore();
    await store.open("/r");
    await settled();
    store.reloadWalk(commit(4).hash);
    await settled();
    expect(store.selectedIndex).toBe(4);
    expect(store.detail?.hash).toBe(commit(4).hash);
  });

  it("empties the rows when the reloaded walk fails before its first page", async () => {
    mockBackend({ reloadFails: true });
    const store = useRepoStore();
    await store.open("/r");
    await settled();
    expect(store.commits.length).toBeGreaterThan(0);
    store.reloadWalk();
    await settled();
    expect(store.commits).toHaveLength(0);
    expect(store.selectedIndex).toBe(-1);
    expect(store.walkError?.code).toBe("repo.corrupt_object");
  });
});

describe("repo store, restarted walks", () => {
  it("restarts with a scope and a filter, keeps the selected commit and its change set", async () => {
    const calls = mockBackend();
    const store = useRepoStore();
    await store.open("/r");
    await settled();
    store.select(2);
    await settled();
    const diffsBefore = calls.filter((c) => c.cmd === "diff").length;
    store.restartWalk({ kind: "ref", name: "main" }, { text: "commit" });
    expect(store.commits).toHaveLength(0);
    expect(store.selectedIndex).toBe(-1);
    expect(store.walkScope).toEqual({ kind: "ref", name: "main" });
    expect(store.walkFilter).toEqual({ text: "commit" });
    await settled();
    const walks = calls.filter((c) => c.cmd === "walk_commits");
    expect(walks).toHaveLength(2);
    expect(walks[1]?.args).toMatchObject({
      scope: { kind: "ref", name: "main" },
      options: { pageSize: 500, order: "lazy", filter: { text: "commit" } },
    });
    expect(store.commits).toHaveLength(3);
    expect(store.selectedIndex).toBe(2);
    expect(store.detail?.hash).toBe(commit(2).hash);
    // The change set was kept: no diff ran for the same commit.
    expect(calls.filter((c) => c.cmd === "diff")).toHaveLength(diffsBefore);
  });

  it("selects the first row when the selected commit is no longer listed", async () => {
    mockBackend();
    const store = useRepoStore();
    await store.open("/r");
    await settled();
    store.select(7);
    await settled();
    store.restartWalk({ kind: "ref", name: "main" });
    await settled();
    expect(store.commits).toHaveLength(3);
    expect(store.selectedIndex).toBe(0);
    expect(store.detail?.hash).toBe(commit(0).hash);
  });

  it("clears the change set when nothing matches", async () => {
    mockBackend();
    const store = useRepoStore();
    await store.open("/r");
    await settled();
    store.restartWalk({ kind: "all" }, { text: "nothing like this" });
    await settled();
    expect(store.commits).toHaveLength(0);
    expect(store.selectedIndex).toBe(-1);
    expect(store.detail).toBeNull();
    expect(store.walk?.done).toBe(true);
    expect(store.streaming).toBe(false);
  });

  it("ignores the pages of a walk restarted before they arrived", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockBackend({ walkGate: gate });
    const store = useRepoStore();
    await store.open("/r");
    await settled();
    // The first filtered walk waits on the gate; a second restart replaces it.
    store.restartWalk({ kind: "all" }, { text: "commit 1" });
    store.restartWalk({ kind: "ref", name: "main" }, { text: "commit" });
    release();
    await settled();
    expect(store.commits).toHaveLength(3);
    expect(store.commits.map((c) => c.subject)).toEqual(["commit 0", "commit 1", "commit 2"]);
  });

  it("a restart before the repository is ready only records the scope", async () => {
    const calls = mockBackend();
    const store = useRepoStore();
    store.restartWalk({ kind: "ref", name: "main" });
    expect(calls).toHaveLength(0);
    await store.open("/r");
    await settled();
    // Opening resets the walk to the whole history.
    expect(store.walkScope).toEqual({ kind: "all" });
    expect(store.commits).toHaveLength(1_200);
  });
});

describe("repo store, after the review", () => {
  it("ignores the earlier stream when the same commit is selected again while its diff runs", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = mockBackend({ diffGate: gate });
    const store = useRepoStore();
    await store.open("/r");
    await settled();
    // The first page selected row 0 and its diff is waiting on the gate; select it again.
    expect(store.detail?.loading).toBe(true);
    store.select(0);
    release();
    await settled();
    expect(calls.filter((c) => c.cmd === "diff")).toHaveLength(2);
    expect(store.detail?.error).toBeUndefined();
    expect(store.detail?.loading).toBe(false);
    expect(store.detail?.files).toHaveLength(1);
  });

  it("restarts a walk the backend dropped and skips the pages already shown", async () => {
    const calls = mockBackend({ loseWalk: true });
    const store = useRepoStore();
    await store.open("/r");
    await settled();
    // Pretend only the first page arrived, then ask for more: the backend lost the walk.
    store.commits = store.commits.slice(0, 500);
    store.walk = { walkId: "walk-1", nextIndex: 1, done: false, skipBefore: 0 };
    store.loadMore();
    await settled();
    expect(store.walkError).toBeNull();
    const restarted = calls.filter((c) => c.cmd === "walk_commits");
    expect(restarted).toHaveLength(2);
    expect(restarted[1]?.args).toMatchObject({ maxPages: 1 + 4 });
    expect(store.commits).toHaveLength(1_200);
    expect(store.commits.map((c) => c.hash)).toEqual(
      Array.from({ length: 1_200 }, (_, i) => commit(i).hash),
    );
    expect(store.walk).toEqual({ walkId: "walk-2", nextIndex: 3, done: true, skipBefore: 1 });
  });

  it("closes the engine of an open abandoned for another repository", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = mockBackend({ openGate: gate });
    const store = useRepoStore();
    const first = store.open("/r");
    await store.close();
    release();
    await first;
    await settled();
    expect(store.state.kind).toBe("empty");
    expect(calls.filter((c) => c.cmd === "close_repository").map((c) => c.args["root"])).toEqual([
      "/r",
    ]);
  });

  it("closes the engine when the refs cannot be listed and reports the error", async () => {
    const calls = mockBackend({ refsFail: true });
    const store = useRepoStore();
    await store.open("/r");
    await settled();
    expect(store.state).toMatchObject({ kind: "error", path: "/r" });
    expect(store.refsLoaded).toBe(false);
    expect(calls.filter((c) => c.cmd === "close_repository")).toHaveLength(1);
  });

  it("refreshes the refs on demand, says whether a tip moved, and ignores a listing that fails", async () => {
    const calls = mockBackend();
    const store = useRepoStore();
    await store.open("/r");
    expect(await store.refreshRefs()).toEqual({ tipsMoved: false });
    expect(calls.filter((c) => c.cmd === "list_refs")).toHaveLength(2);
    expect(store.refs).toHaveLength(1);
    clearMocks();
    mockBackend({ refsFail: true });
    expect(await store.refreshRefs()).toEqual({ tipsMoved: false });
    expect(store.refs).toHaveLength(1);
    expect(store.state.kind).toBe("ready");
    // A branch pointing elsewhere is a moved tip; a stash entry is not.
    const main = store.refs[0]!;
    clearMocks();
    mockBackend({ refs: [{ ...main, target: commit(5).hash }] });
    expect(await store.refreshRefs()).toEqual({ tipsMoved: true });
    clearMocks();
    mockBackend({
      refs: [
        { ...main, target: commit(5).hash },
        {
          ...main,
          name: "stash@{0}",
          fullName: "refs/stash",
          kind: "stash",
          target: "f".repeat(40),
        },
      ],
    });
    expect(await store.refreshRefs()).toEqual({ tipsMoved: false });
    expect(tipsSignature(store.refs)).toBe(`refs/heads/main=${commit(5).hash}`);
    expect(store.recentlyRestarted()).toBe(false);
    store.restartWalk(store.walkScope, store.walkFilter);
    expect(store.recentlyRestarted()).toBe(true);
    expect(store.recentlyRestarted(0)).toBe(false);
  });

  it("follows HEAD's branch through the refs listing, keeping an unborn branch's name", async () => {
    mockBackend();
    const store = useRepoStore();
    await store.open("/r");
    const main = store.refs[0]!;
    const head: GitRef = { ...main, name: "HEAD", fullName: "HEAD", kind: "head" };
    const develop: GitRef = { ...main, name: "develop", fullName: "refs/heads/develop" };
    expect(store.repo).toMatchObject({ currentBranch: "main", detached: false });
    // `git switch develop` in a terminal.
    clearMocks();
    mockBackend({ refs: [{ ...develop, isCurrent: true }, { ...main, isCurrent: false }, head] });
    await store.refreshRefs();
    expect(store.repo).toMatchObject({ currentBranch: "develop", detached: false });
    // `git switch --detach`.
    clearMocks();
    mockBackend({ refs: [{ ...develop, isCurrent: false }, { ...main, isCurrent: false }, head] });
    await store.refreshRefs();
    expect(store.repo).toMatchObject({ currentBranch: null, detached: true });
    // An unborn branch lists neither HEAD nor a current branch: what is known stays.
    clearMocks();
    mockBackend({ refs: [] });
    await store.refreshRefs();
    expect(store.repo).toMatchObject({ currentBranch: null, detached: true });
    expect(headState([])).toBeNull();
  });

  it("marks the refs as loaded once they arrive", async () => {
    mockBackend();
    const store = useRepoStore();
    const opening = store.open("/r");
    expect(store.refsLoaded).toBe(false);
    await opening;
    expect(store.refsLoaded).toBe(true);
  });
});
