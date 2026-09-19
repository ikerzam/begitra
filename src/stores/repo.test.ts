import type { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CommitNode, Repo } from "@/ipc/schemas";

import { useOperationsStore } from "./operations";
import { useRepoStore } from "./repo";

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
          },
        ];
      case "walk_commits":
      case "walk_continue": {
        if (cmd === "walk_commits") walks += 1;
        if (cmd === "walk_continue" && options.loseWalk && walks < 2) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
          return Promise.reject({ code: "op.unknown_walk", message: "Walk walk-1 is not open" });
        }
        const first = cmd === "walk_commits" ? 0 : (args["nextIndex"] as number);
        const maxPages = args["maxPages"] as number;
        const messages: unknown[] = [];
        let seq = 0;
        for (let index = first; index < first + maxPages; index += 1) {
          const start = index * 500;
          if (start >= total) break;
          const commits = Array.from({ length: Math.min(500, total - start) }, (_, i) =>
            commit(start + i),
          );
          const done = start + commits.length >= total;
          const walkId = `walk-${walks}`;
          messages.push({ kind: "page", seq, data: { walkId, index, commits, done } });
          seq += 1;
          if (done) break;
        }
        messages.push({ kind: "done" });
        send(args["onPage"] as Channel<unknown>, messages);
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

  it("marks the refs as loaded once they arrive", async () => {
    mockBackend();
    const store = useRepoStore();
    const opening = store.open("/r");
    expect(store.refsLoaded).toBe(false);
    await opening;
    expect(store.refsLoaded).toBe(true);
  });
});
