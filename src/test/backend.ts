// A fake Tauri backend for graph tests: a repository whose walk honours the scope and the
// filter the way the engine does, pages of a chosen size, an optional failure after a page,
// counts per scope, empty diffs. Every call is recorded for assertions.

import type { Channel } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";

import type {
  Annotation,
  AnnotationWrite,
  CommitNode,
  DiffLine,
  DiffTarget,
  FileChange,
  Hunk,
  WalkFilter,
  WalkScope,
} from "@/ipc/schemas";

export interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

export interface FakeBackendOptions {
  /** Commits in the repository (subject "commit N", authors cycling). Default 30. */
  commits?: number;
  pageSize?: number;
  /** After this many pages the walk ends with `repo.corrupt_object`. */
  failAfterPages?: number;
  /** Commits a ref scope lists (the first N). Default 10. */
  refScopeCommits?: number;
  /** Every diff fails with `diff.blob_missing`. */
  failDiff?: boolean;
  /** Annotation writes reject. */
  failAnnotations?: boolean;
  /** The annotations the index holds at start, per target key. */
  annotations?: Record<string, Annotation[]>;
}

/** The files a diff of `target` lists: two text files, an image and a generated one. */
export function fakeFiles(target: DiffTarget): FileChange[] {
  const tag = target.kind === "commit" ? target.hash.slice(-2) : target.kind;
  const line = (kind: "context" | "added" | "removed", n: number, text: string): DiffLine => ({
    kind,
    oldNumber: kind === "added" ? null : n,
    newNumber: kind === "removed" ? null : n,
    text,
    spans: [],
    noNewline: false,
  });
  const hunk: Hunk = {
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 3,
    header: "@@ -1,2 +1,3 @@ fn main",
    lines: [
      line("context", 1, "fn main() {"),
      line("removed", 2, "    old();"),
      line("added", 2, "    new();"),
      line("added", 3, "    more();"),
    ],
  };
  const base = {
    oldPath: null,
    similarity: null,
    isBinary: false,
    isLarge: false,
    isGenerated: false,
    isTest: false,
  };
  return [
    {
      ...base,
      status: "modified",
      path: `src/${tag}.rs`,
      additions: 2,
      deletions: 1,
      hunks: [hunk],
    },
    {
      ...base,
      status: "added",
      path: "src/lib.ts",
      additions: 5,
      deletions: 0,
      hunks: [{ ...hunk, header: "@@ -0,0 +1,3 @@" }],
    },
    {
      ...base,
      status: "added",
      path: "docs/tiles-worker.png",
      additions: 0,
      deletions: 0,
      hunks: [],
      isBinary: true,
    },
    {
      ...base,
      status: "modified",
      path: "pnpm-lock.yaml",
      additions: 212,
      deletions: 190,
      hunks: [hunk],
      isGenerated: true,
    },
  ];
}

const AUTHORS = ["iker", "claude", "ane"] as const;

/** Commit `n`: one day apart, authors cycling, every fifth subject starting with "fix(auth)". */
export function fakeCommit(n: number): CommitNode {
  const name = AUTHORS[n % 3] ?? "iker";
  const who = { name, email: `${name}@x`, time: 1_700_000_000 - n * 86_400, offsetMinutes: 0 };
  return {
    hash: n.toString(16).padStart(40, "0"),
    parents: [(n + 1).toString(16).padStart(40, "0")],
    author: who,
    committer: who,
    subject: n % 5 === 0 ? `fix(auth): commit ${n}` : `commit ${n}`,
    body: n % 7 === 0 ? `body of ${n}` : "",
    refs: n === 0 ? ["HEAD", "main"] : [],
    lane: n % 3,
    edges: [{ fromLane: n % 3, toLane: (n + 1) % 3, parent: (n + 1).toString(16) }],
    overflow: 0,
  };
}

export function fakeBackend(options: FakeBackendOptions = {}): Call[] {
  const calls: Call[] = [];
  const total = options.commits ?? 30;
  const pageSize = options.pageSize ?? 500;
  const all = Array.from({ length: total }, (_, i) => fakeCommit(i));
  const annotations: Record<string, Annotation[]> = options.annotations ?? {};
  const send = (channel: Channel<unknown>, messages: unknown[]) => {
    queueMicrotask(() => {
      for (const message of messages) channel.onmessage(message);
    });
  };
  const listFor = (scope: WalkScope, filter: WalkFilter): CommitNode[] => {
    let listed = scope.kind === "ref" ? all.slice(0, options.refScopeCommits ?? 10) : all;
    if (filter.text) {
      const text = filter.text.toLowerCase();
      listed = listed.filter((c) => c.subject.toLowerCase().includes(text));
    }
    if (filter.author) listed = listed.filter((c) => c.author.name === filter.author);
    if (filter.since !== undefined) {
      listed = listed.filter((c) => c.author.time >= (filter.since ?? 0));
    }
    if (filter.paths) listed = listed.filter((_c, i) => i % 2 === 0);
    return listed;
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
        return [
          {
            name: "main",
            fullName: "refs/heads/main",
            kind: "local-branch",
            target: fakeCommit(0).hash,
            isCurrent: true,
            upstream: null,
            ahead: null,
            behind: null,
            worktree: "/r",
            message: null,
          },
          {
            name: "develop",
            fullName: "refs/heads/develop",
            kind: "local-branch",
            target: fakeCommit(3).hash,
            isCurrent: false,
            upstream: null,
            ahead: null,
            behind: null,
            worktree: null,
            message: null,
          },
        ];
      case "walk_commits":
      case "walk_continue": {
        const scope = (args["scope"] as WalkScope | undefined) ?? { kind: "all" };
        const filter = (args["options"] as { filter?: WalkFilter } | undefined)?.filter ?? {};
        const listed = listFor(scope, filter);
        const first = cmd === "walk_commits" ? 0 : (args["nextIndex"] as number);
        const maxPages = args["maxPages"] as number;
        const messages: unknown[] = [];
        let seq = 0;
        if (listed.length === 0) {
          messages.push({
            kind: "page",
            seq,
            data: { walkId: "w", index: 0, commits: [], done: true },
          });
          seq += 1;
        }
        for (let index = first; index < first + maxPages; index += 1) {
          if (options.failAfterPages !== undefined && index >= options.failAfterPages) {
            messages.push({
              kind: "error",
              error: {
                code: "repo.corrupt_object",
                message: "object 6c1f0ab is missing or corrupt: loose object is corrupt",
                detail: "error: object file .git/objects/6c/1f0ab is empty",
              },
            });
            send(args["onPage"] as Channel<unknown>, messages);
            return null;
          }
          const start = index * pageSize;
          if (start >= listed.length) break;
          const commits = listed.slice(start, start + pageSize);
          const done = start + commits.length >= listed.length;
          messages.push({ kind: "page", seq, data: { walkId: "w", index, commits, done } });
          seq += 1;
          if (done) break;
        }
        messages.push({ kind: "done" });
        send(args["onPage"] as Channel<unknown>, messages);
        return null;
      }
      case "count_commits": {
        const scope = args["scope"] as WalkScope;
        return { count: listFor(scope, {}).length, capped: false };
      }
      case "diff": {
        if (options.failDiff) {
          send(args["onPage"] as Channel<unknown>, [
            {
              kind: "error",
              error: {
                code: "diff.blob_missing",
                message: "blob 4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e is missing",
                detail: "fatal: unable to read 4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e",
              },
            },
          ]);
          return null;
        }
        const files = fakeFiles(args["target"] as DiffTarget);
        const additions = files.reduce((n, f) => n + f.additions, 0);
        const deletions = files.reduce((n, f) => n + f.deletions, 0);
        send(args["onPage"] as Channel<unknown>, [
          {
            kind: "page",
            seq: 0,
            data: { additions, deletions, totalFiles: files.length, files },
          },
          { kind: "done" },
        ]);
        return null;
      }
      case "read_blob": {
        const path = args["path"] as string;
        if (path.endsWith(".png")) {
          return { size: 5, isBinary: true, bytes: "iVBORwA=" };
        }
        return { size: 12, isBinary: false, text: "fn main() {\n    new();\n    more();\n}\n" };
      }
      case "highlight_file":
        return {
          syntax: "Rust",
          lines: [
            [{ start: 0, end: 2, class: "keyword" }],
            [],
            [{ start: 4, end: 8, class: "function" }],
            [],
          ],
          complete: true,
        };
      case "file_symbols":
        return [{ kind: "function", name: "main", startLine: 1, endLine: 4 }];
      case "list_annotations":
        return annotations[args["target"] as string] ?? [];
      case "set_annotation": {
        if (options.failAnnotations) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
          return Promise.reject({ code: "index.database", message: "database locked" });
        }
        const target = args["target"] as string;
        const write = args["annotation"] as AnnotationWrite;
        const list = (annotations[target] ??= []);
        const index = list.findIndex(
          (a) => a.path === write.path && a.hunk === write.hunk && a.kind === write.kind,
        );
        const stored: Annotation = {
          ...write,
          hunk: write.hunk ?? "",
          value: write.value ?? "",
          updatedAt: 1,
        };
        if (index >= 0) list[index] = stored;
        else list.push(stored);
        return null;
      }
      case "delete_annotation": {
        if (options.failAnnotations) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
          return Promise.reject({ code: "index.database", message: "database locked" });
        }
        const target = args["target"] as string;
        const write = args["annotation"] as AnnotationWrite;
        const list = annotations[target] ?? [];
        const index = list.findIndex(
          (a) => a.path === write.path && a.hunk === write.hunk && a.kind === write.kind,
        );
        if (index >= 0) list.splice(index, 1);
        return index >= 0;
      }
      case "list_worktrees":
        return [];
      case "watch_repository":
      case "record_repository_open":
      case "refresh_repository":
        return null;
      case "list_repositories":
        return [];
      case "open_external":
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

/** Lets microtasks, the IPC mock and one macrotask run. */
export async function settled(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
