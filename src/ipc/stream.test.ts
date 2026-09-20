import type { Channel } from "@tauri-apps/api/core";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, describe, expect, it, vi } from "vitest";

import { diff, walkCommits } from "./commands";
import { AppError } from "./errors";
import type { CommitNode, WalkPage } from "./schemas";

type Message = Record<string, unknown>;

function commit(n: number): CommitNode {
  const who = { name: "a", email: "a@x", time: 0, offsetMinutes: 0 };
  return {
    hash: n.toString(16).padStart(40, "0"),
    parents: [],
    author: who,
    committer: who,
    subject: `c${n}`,
    body: "",
    refs: [],
    lane: 0,
    edges: [],
    overflow: 0,
  };
}

function page(index: number, size: number, done: boolean): WalkPage {
  return {
    walkId: "walk-1",
    index,
    commits: Array.from({ length: size }, (_, i) => commit(index * 500 + i)),
    done,
  };
}

/** Mocks the backend: `script` receives the channel of a streamed command and drives it. */
function mockStream(
  script: (send: (message: Message) => void, args: Record<string, unknown>) => void,
) {
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  mockIPC((cmd, args) => {
    const record = { cmd, args: (args ?? {}) as Record<string, unknown> };
    calls.push(record);
    if (cmd === "cancel_operation") return true;
    const channel = record.args["onPage"] as Channel<unknown>;
    queueMicrotask(() => script((message) => channel.onmessage(message), record.args));
    return null;
  });
  return calls;
}

afterEach(() => {
  clearMocks();
});

describe("stream", () => {
  it("delivers three pages of at most 500 commits in order, then done", async () => {
    mockStream((send) => {
      send({ kind: "page", seq: 0, data: page(0, 500, false) });
      send({ kind: "page", seq: 1, data: page(1, 500, false) });
      send({ kind: "page", seq: 2, data: page(2, 200, true) });
      send({ kind: "done" });
    });
    const seen: [number, number][] = [];
    const handle = walkCommits("/r", { kind: "all" }, (p, seq) =>
      seen.push([seq, p.commits.length]),
    );
    await expect(handle.done).resolves.toBeUndefined();
    expect(seen).toEqual([
      [0, 500],
      [1, 500],
      [2, 200],
    ]);
  });

  it("passes the operation id, the arguments and the channel to the command", async () => {
    const calls = mockStream((send) => send({ kind: "done" }));
    const handle = walkCommits("/r", { kind: "ref", name: "main" }, () => {}, {
      pageSize: 100,
      order: "date-topo",
    });
    await handle.done;
    expect(calls[0]?.cmd).toBe("walk_commits");
    expect(calls[0]?.args).toMatchObject({
      repo: "/r",
      scope: { kind: "ref", name: "main" },
      options: { pageSize: 100, order: "date-topo" },
      maxPages: 4,
      opId: handle.opId,
    });
    expect(calls[0]?.args["onPage"]).toBeDefined();
  });

  it("rejects with the terminal error and delivers nothing after it", async () => {
    mockStream((send) => {
      send({ kind: "page", seq: 0, data: page(0, 2, false) });
      send({
        kind: "error",
        error: { code: "repo.corrupt_object", message: "object abc is corrupt" },
      });
      send({ kind: "page", seq: 1, data: page(1, 2, false) });
      send({ kind: "done" });
    });
    const pages: number[] = [];
    const handle = walkCommits("/r", { kind: "all" }, (p) => pages.push(p.index));
    const error = await handle.done.catch((e: unknown) => e as AppError);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("repo.corrupt_object");
    expect(pages).toEqual([0]);
  });

  it("rejects with internal when a page does not match the schema", async () => {
    mockStream((send) => {
      send({ kind: "page", seq: 0, data: { walkId: "w", index: 0, commits: "nope", done: false } });
    });
    const handle = walkCommits("/r", { kind: "all" }, () => {});
    const error = await handle.done.catch((e: unknown) => e as AppError);
    expect((error as AppError).code).toBe("internal");
    expect((error as AppError).detail).toMatch(/^commits: /);
  });

  it("cancel ends the stream at once, drops later pages and asks the backend to stop", async () => {
    let late: (() => void) | undefined;
    const calls = mockStream((send) => {
      send({ kind: "page", seq: 0, data: page(0, 1, false) });
      // The backend keeps going for a while after the cancel request.
      late = () => {
        send({ kind: "page", seq: 1, data: page(1, 1, false) });
        send({ kind: "done" });
      };
    });
    const pages: number[] = [];
    const handle = walkCommits("/r", { kind: "all" }, (p) => pages.push(p.index));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await handle.cancel();
    late?.();
    const error = await handle.done.catch((e: unknown) => e as AppError);
    expect((error as AppError).code).toBe("op.cancelled");
    expect(pages).toEqual([0]);
    expect(calls.some((c) => c.cmd === "cancel_operation" && c.args["opId"] === handle.opId)).toBe(
      true,
    );
  });

  it("cancel does not fail when the backend cannot be reached", async () => {
    mockIPC((cmd) => {
      if (cmd === "cancel_operation") return Promise.reject(new Error("gone"));
      return null;
    });
    const handle = walkCommits("/r", { kind: "all" }, () => {});
    await expect(handle.cancel()).resolves.toBeUndefined();
    await expect(handle.done).rejects.toMatchObject({ code: "op.cancelled" });
  });

  it("rejects when the command itself fails before any message", async () => {
    mockIPC(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Tauri rejects with the serialised AppError object
      throw { code: "repo.not_found", message: "No Git repository found at or above /x" };
    });
    const handle = walkCommits("/x", { kind: "all" }, () => {});
    const error = await handle.done.catch((e: unknown) => e as AppError);
    expect((error as AppError).code).toBe("repo.not_found");
  });

  it("rejects an invalid argument without invoking", async () => {
    const invoke = vi.fn();
    mockIPC(invoke);
    const handle = diff("/r", { kind: "commit", hash: "" }, () => {}, {
      renames: true,
      similarity: 150,
      context: 3,
      intraLine: true,
      ignoreWhitespace: false,
    });
    const error = await handle.done.catch((e: unknown) => e as AppError);
    expect((error as AppError).code).toBe("ipc.invalid_argument");
    expect((error as AppError).detail).toMatch(/^options\.similarity: /);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("streams diff pages with totals", async () => {
    mockStream((send) => {
      send({
        kind: "page",
        seq: 0,
        data: { additions: 3, deletions: 1, totalFiles: 1, files: [] },
      });
      send({ kind: "done" });
    });
    const pages: number[] = [];
    const handle = diff("/r", { kind: "index" }, (p) => pages.push(p.totalFiles));
    await handle.done;
    expect(pages).toEqual([1]);
  });
});
