// A fake Tauri backend for graph tests: a repository whose walk honours the scope and the
// filter the way the engine does, pages of a chosen size, an optional failure after a page,
// counts per scope, empty diffs. Every call is recorded for assertions.

import type { Channel } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";

import { comparePaths, covers } from "@/stores/reloads";

import type {
  Annotation,
  AnnotationWrite,
  CommitContext,
  CommitNode,
  Conflict,
  DiffLine,
  DiffTarget,
  FileChange,
  Hunk,
  IndexEntry,
  MergePreview,
  OperationState,
  Outcome,
  PatchSelection,
  Project,
  Ref,
  Remote,
  RepoSummary,
  SelectionTarget,
  WalkFilter,
  WalkScope,
  Worktree,
  WorktreeAdd,
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
  /** Commits a range scope lists. Default 3. */
  rangeCommits?: number;
  /** `compare` rejects with `refs.unrelated_histories`. */
  failCompare?: boolean;
  /** `merge_preview` rejects with `git.cli_failed`. */
  failPreview?: boolean;
  /** What `merge_preview` answers. Default: three conflicts. */
  preview?: MergePreview;
  /** The worktrees `list_worktrees` answers; the worktree writes change the list. */
  worktrees?: Worktree[];
  /** What `refresh_repository` answers for a path; a path not listed answers nothing. */
  summaries?: Record<string, RepoSummary>;
  /** `refresh_repository` rejects with these errors, per path. */
  summaryErrors?: Record<string, { code: string; message: string; detail?: string }>;
  /** `refresh_repository` answers after this many milliseconds. */
  summaryDelayMs?: number;
  /** `worktree_remove` without `force` rejects with `worktree.dirty` for these paths. */
  dirtyWorktrees?: string[];
  /** `worktree_add` rejects with `git.cli_failed`. */
  failWorktreeAdd?: boolean;
  /** The paths `path_exists` answers true for. */
  existingPaths?: string[];
  /** What `detect_git` answers; default `/usr/bin/git` 2.46.0. When false, it fails. */
  gitDetection?: { path: string; version: string } | false;
  /** The executables `set_git_executable` accepts besides "" and "git"; others fail. */
  gitExecutables?: string[];
  /**
   * The lists of the changes screen: what the working-tree-against-index and the index diffs
   * answer. The staging writes move files between them by path (a partial selection keeps
   * the file in both), discard removes them, a commit empties the staged list.
   */
  changes?: { unstaged: FileChange[]; staged: FileChange[] };
  /** The changes of other repositories, by root (the folder view); stage, unstage and
   * discard move their files as they do the open repository's. */
  changesByRepo?: Record<string, { unstaged: FileChange[]; staged: FileChange[] }>;
  /** What `list_repositories` answers; none by default. */
  repositories?: IndexEntry[];
  /** `list_repositories` rejects with `index.database`. */
  failIndex?: boolean;
  /** Tauri's events go through the mock, so `emit` reaches the app's listeners. */
  mockEvents?: boolean;
  /** Folders `open_repository` refuses with `repo.not_found` (folders of repositories). */
  notRepositories?: string[];
  /** Every staging write rejects with `git.cli_failed` (a stale hunk). */
  failStaging?: boolean;
  /** `commit` rejects with `git.cli_failed` (a hook's output). */
  failCommit?: boolean;
  /** What `commit_context` answers, over the defaults (a born branch, no template). */
  commitContext?: Partial<CommitContext>;
  /** Every diff answers after this many milliseconds (the loading states, by eye). */
  diffDelayMs?: number;
  /**
   * `diff_paths` answers after this many milliseconds, per target: the index against HEAD or
   * the working tree. The answer is the lists as they were when it was asked.
   */
  diffPathsDelayMs?: { index?: number; workingTree?: number };
  /** `open_repository` answers with the path it is given as the root, not `/r`. */
  rootIsPath?: boolean;
  /** The network commands end after this many milliseconds (the progress, by eye). */
  networkDelayMs?: number;
  /** The refs `list_refs` answers; the two local branches by default. */
  refs?: Ref[];
  /** The remotes `remotes` answers; `remote_add` and `remote_remove` change the list. */
  remotes?: Remote[];
  /** What the operations that may stop on conflicts answer; done on a new commit by default. */
  outcome?: Outcome;
  /** What `operation_state` and `conflicts` answer. */
  operation?: OperationState;
  conflicts?: Conflict[];
  /** Apply, pop and drop reject with `stash.not_found` (the stash went outside the app). */
  stashGone?: boolean;
  /** `switch` rejects with git's "would be overwritten" message. */
  dirtySwitch?: boolean;
  /** `branch_delete` without force rejects with "not fully merged". */
  unmergedBranch?: boolean;
  /** The network commands stream these lines, then fail with a rejected push. */
  failNetwork?: boolean;
  /** The network commands of these repositories end with these errors. */
  networkErrors?: Record<string, { code: string; message: string; detail?: string }>;
  /** `switch` and `branch_create` in these repositories reject with these errors. */
  writeErrors?: Record<string, { code: string; message: string; detail?: string }>;
  /** `stash_push` answers false (nothing to save). */
  stashNothing?: boolean;
  /** The projects `projects` answers at start; the project writes change the list. */
  projects?: Project[];
  /** Every project command rejects with `index.database`. */
  failProjects?: boolean;
  /** `open_external` rejects these paths with `external.not_found`, as the backend does for a
   * path that is not on disk. */
  missingPaths?: string[];
}

/** The hash the operations that move HEAD answer. */
export const FAKE_OUTCOME_HASH = "beef00".padEnd(40, "0");

/** The progress lines every network command streams before its result. */
export const FAKE_PROGRESS = ["Enumerating objects: 12, done.", "Writing objects: 100% (12/12)"];

/** The hash `commit` answers. */
export const FAKE_COMMIT_HASH = "c0ffee".padEnd(40, "0");

/** Whether every changed line of a selection is selected. */
function selectsWhole(selection: PatchSelection): boolean {
  return selection.hunks.every((hunk) =>
    hunk.lines.every((line) => line.kind === "context" || line.selected),
  );
}

/** The main worktree at `/r` and two linked ones, one of them prunable. */
export function fakeWorktrees(): Worktree[] {
  return [
    {
      path: "/r",
      name: null,
      head: fakeCommit(0).hash,
      branch: "main",
      detached: false,
      isMain: true,
      locked: false,
      lockReason: null,
      prunable: false,
    },
    {
      path: "/wt/claude-auth",
      name: "claude-auth",
      head: fakeCommit(4).hash,
      branch: "claude/fix-auth",
      detached: false,
      isMain: false,
      locked: false,
      lockReason: null,
      prunable: false,
    },
    {
      path: "/wt/gone",
      name: "gone",
      head: fakeCommit(6).hash,
      branch: "gone",
      detached: false,
      isMain: false,
      locked: true,
      lockReason: "review",
      prunable: true,
    },
  ];
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
    isLossy: false,
    oldId: null,
    newId: null,
  };
  const files: FileChange[] = [
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
  // Ids as the engine gives them, none for a side the file does not have.
  return files.map((file) => ({
    ...file,
    oldId: file.status === "added" ? null : `old:${tag}:${file.path}`,
    newId: `new:${tag}:${file.path}`,
  }));
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

/** What the backend answers for a stash that is no longer in the list. */
function stashGone(args: Record<string, unknown>): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
  return Promise.reject({
    code: "stash.not_found",
    message: `stash ${String(args["stash"])} is no longer in the stash list`,
  });
}

export function fakeBackend(options: FakeBackendOptions = {}): Call[] {
  const calls: Call[] = [];
  const total = options.commits ?? 30;
  const pageSize = options.pageSize ?? 500;
  const all = Array.from({ length: total }, (_, i) => fakeCommit(i));
  const annotations: Record<string, Annotation[]> = options.annotations ?? {};
  let worktrees: Worktree[] = (options.worktrees ?? []).map((worktree) => ({ ...worktree }));
  let remotes: Remote[] = (options.remotes ?? []).map((remote) => ({ ...remote }));
  let projects: Project[] = (options.projects ?? []).map((project) => ({
    ...project,
    members: [...project.members],
  }));
  /** The clock of the project writes: one tick per write. */
  let projectClock = 1_704_100_000;
  const byName = (a: Project, b: Project) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id - b.id;
  const unique = (paths: string[]) => [...new Set(paths)];
  const projectFailure = () =>
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
    Promise.reject({ code: "index.database", message: "database is locked" });
  let unstaged: FileChange[] = [...(options.changes?.unstaged ?? [])];
  let staged: FileChange[] = [...(options.changes?.staged ?? [])];
  const byRepo = new Map(
    Object.entries(options.changesByRepo ?? {}).map(([root, lists]) => [
      root,
      { unstaged: [...lists.unstaged], staged: [...lists.staged] },
    ]),
  );
  /**
   * What a diff of `target` answers: the changes lists when given, else the fake files; the
   * lists in the engine's order, by path.
   */
  const filesOf = (target: DiffTarget, repo?: unknown): FileChange[] => {
    const own = typeof repo === "string" ? byRepo.get(repo) : undefined;
    if (own) {
      const listed =
        target.kind === "index"
          ? own.staged
          : target.kind === "working-tree" && target.base === "index"
            ? own.unstaged
            : [];
      return [...listed].sort((a, b) => comparePaths(a.path, b.path));
    }
    return filesOfOpen(target);
  };
  const filesOfOpen = (target: DiffTarget): FileChange[] =>
    !options.changes
      ? fakeFiles(target)
      : [
          ...(target.kind === "index"
            ? staged
            : target.kind === "working-tree" && target.base === "index"
              ? unstaged
              : fakeFiles(target)),
        ].sort((a, b) => comparePaths(a.path, b.path));
  const stagingFailure = () =>
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
    Promise.reject({
      code: "git.cli_failed",
      message: "git apply failed",
      detail: "error: patch failed: src/lib.ts:1\nerror: src/lib.ts: patch does not apply",
    });
  /** Moves the files at `paths` from one list to the other. */
  const move = (
    paths: string[],
    from: FileChange[],
    to: FileChange[],
  ): [FileChange[], FileChange[]] => {
    const moving = from.filter((file) => paths.includes(file.path));
    const kept = to.filter((file) => !paths.includes(file.path));
    return [from.filter((file) => !paths.includes(file.path)), [...kept, ...moving]];
  };
  const entryFor = (path: string, summary: RepoSummary): IndexEntry => ({
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    kind: path === "/r" ? "main" : "worktree",
    parentPath: path === "/r" ? null : "/r",
    scanRoot: null,
    summary,
    pinned: false,
    lastOpenedAt: null,
    refreshedAt: 1_700_000_000,
    missing: false,
  });
  const send = (channel: Channel<unknown>, messages: unknown[], delayMs?: number) => {
    const deliver = () => {
      for (const message of messages) channel.onmessage(message);
    };
    if (delayMs) setTimeout(deliver, delayMs);
    else queueMicrotask(deliver);
  };
  const listFor = (scope: WalkScope, filter: WalkFilter): CommitNode[] => {
    let listed =
      scope.kind === "ref"
        ? all.slice(0, options.refScopeCommits ?? 10)
        : scope.kind === "range"
          ? all.slice(0, options.rangeCommits ?? 3)
          : all;
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
  /** The repository the slot watches, which `watch_folder` leaves out, as the backend does. */
  let opened: string | null = null;
  mockIPC(
    (cmd, rawArgs) => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args });
      switch (cmd) {
        case "open_repository": {
          if (options.notRepositories?.includes(args["path"] as string)) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({ code: "repo.not_found", message: "not a git repository" });
          }
          const root = options.rootIsPath ? (args["path"] as string) : "/r";
          opened = root;
          return {
            root,
            commonDir: `${root}/.git`,
            currentBranch: "main",
            detached: false,
            isLinkedWorktree: false,
          };
        }
        case "list_refs":
          if (options.refs) return options.refs.map((entry) => ({ ...entry }));
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
              committedAt: fakeCommit(0).committer.time,
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
              committedAt: fakeCommit(3).committer.time,
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
          const target = args["target"] as DiffTarget;
          const files = filesOf(target, args["repo"]);
          const additions = files.reduce((n, f) => n + f.additions, 0);
          const deletions = files.reduce((n, f) => n + f.deletions, 0);
          send(
            args["onPage"] as Channel<unknown>,
            [
              {
                kind: "page",
                seq: 0,
                data: { additions, deletions, totalFiles: files.length, files },
              },
              { kind: "done" },
            ],
            options.diffDelayMs,
          );
          return null;
        }
        case "diff_paths": {
          // The full diff's files that the paths cover, as the engine restricts it.
          const requested = args["paths"] as string[];
          const target = args["target"] as DiffTarget;
          const files = filesOf(target, args["repo"]).filter((file) =>
            requested.some(
              (path) =>
                covers(path, file.path) || (file.oldPath !== null && covers(path, file.oldPath)),
            ),
          );
          const answer =
            files.length > 200
              ? null
              : {
                  files,
                  additions: files.reduce((n, f) => n + f.additions, 0),
                  deletions: files.reduce((n, f) => n + f.deletions, 0),
                };
          const delay =
            target.kind === "index"
              ? options.diffPathsDelayMs?.index
              : options.diffPathsDelayMs?.workingTree;
          return delay === undefined
            ? answer
            : new Promise((resolve) => setTimeout(() => resolve(answer), delay));
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
        case "compare": {
          if (options.failCompare) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "refs.unrelated_histories",
              message: "main and orphan have unrelated histories",
            });
          }
          const a = args["a"] as string;
          const b = args["b"] as string;
          const hashOf = (rev: string) =>
            /^[0-9a-f]{40}$/.test(rev) ? rev : fakeCommit(rev.length % 7).hash;
          const same = hashOf(a) === hashOf(b);
          return {
            a: { rev: a, hash: hashOf(a) },
            b: { rev: b, hash: hashOf(b) },
            base: { hash: fakeCommit(9).hash, time: fakeCommit(9).author.time },
            onlyInA: same ? 0 : 4,
            onlyInB: same ? 0 : 3,
            relation: same ? "same" : "diverged",
          };
        }
        case "merge_preview":
          if (options.failPreview) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "git.cli_failed",
              message: "git merge-tree failed",
              detail: "fatal: not a tree object: 7f8e9d0",
            });
          }
          return (
            options.preview ?? {
              kind: "conflicts",
              conflicts: ["src/lib.ts", "src/other.ts"],
            }
          );
        case "list_worktrees":
          return worktrees.map((worktree) => ({ ...worktree }));
        case "worktree_add": {
          if (options.failWorktreeAdd) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "git.cli_failed",
              message: "git worktree add failed",
              detail: "fatal: 'develop' is already used by worktree at '/wt/develop'",
            });
          }
          const request = args["request"] as WorktreeAdd;
          const branch = request.branch;
          const added: Worktree = {
            path: request.path,
            name: request.path.slice(request.path.lastIndexOf("/") + 1),
            head: fakeCommit(2).hash,
            branch: branch.kind === "detached" ? null : branch.name,
            detached: branch.kind === "detached",
            isMain: false,
            locked: false,
            lockReason: null,
            prunable: false,
          };
          worktrees = [...worktrees, added];
          return { ...added };
        }
        case "worktree_remove": {
          const path = args["path"] as string;
          if (!args["force"] && options.dirtyWorktrees?.includes(path)) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "worktree.dirty",
              message: `the worktree ${path} has uncommitted changes`,
            });
          }
          worktrees = worktrees.filter((worktree) => worktree.path !== path);
          return null;
        }
        case "worktree_prune": {
          const pruned = worktrees.filter((worktree) => worktree.prunable).map((w) => w.path);
          worktrees = worktrees.filter((worktree) => !worktree.prunable);
          return pruned;
        }
        case "worktree_lock": {
          const path = args["path"] as string;
          worktrees = worktrees.map((worktree) =>
            worktree.path === path
              ? { ...worktree, locked: true, lockReason: (args["reason"] as string | null) ?? null }
              : worktree,
          );
          return null;
        }
        case "worktree_unlock": {
          const path = args["path"] as string;
          worktrees = worktrees.map((worktree) =>
            worktree.path === path ? { ...worktree, locked: false, lockReason: null } : worktree,
          );
          return null;
        }
        case "detect_git":
          if (options.gitDetection === false) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "git.cli_failed",
              message: "no git found",
              detail: "could not start git: program not found",
            });
          }
          return options.gitDetection ?? { path: "/usr/bin/git", version: "git version 2.46.0" };
        case "set_git_executable": {
          const path = args["path"] as string;
          const known = ["", "git", ...(options.gitExecutables ?? ["/usr/bin/git"])];
          if (!known.includes(path)) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "git.cli_failed",
              message: `${path} is not git`,
              detail: `could not start ${path}: program not found`,
            });
          }
          return { path: path === "" ? "git" : path, version: "git version 2.46.0" };
        }
        case "path_exists":
          return options.existingPaths?.includes(args["path"] as string) ?? false;
        case "stage_paths": {
          if (options.failStaging) return stagingFailure();
          const own = byRepo.get(args["repo"] as string);
          if (own) {
            [own.unstaged, own.staged] = move(args["paths"] as string[], own.unstaged, own.staged);
            return null;
          }
          [unstaged, staged] = move(args["paths"] as string[], unstaged, staged);
          return null;
        }
        case "unstage_paths": {
          if (options.failStaging) return stagingFailure();
          const own = byRepo.get(args["repo"] as string);
          if (own) {
            [own.staged, own.unstaged] = move(args["paths"] as string[], own.staged, own.unstaged);
            return null;
          }
          [staged, unstaged] = move(args["paths"] as string[], staged, unstaged);
          return null;
        }
        case "discard_paths": {
          if (options.failStaging) return stagingFailure();
          const gone = [...(args["tracked"] as string[]), ...(args["untracked"] as string[])];
          const own = byRepo.get(args["repo"] as string);
          if (own) {
            own.unstaged = own.unstaged.filter((file) => !gone.includes(file.path));
            return null;
          }
          unstaged = unstaged.filter((file) => !gone.includes(file.path));
          return null;
        }
        case "apply_selection": {
          if (options.failStaging) return stagingFailure();
          const selection = args["selection"] as PatchSelection;
          const target = args["target"] as SelectionTarget;
          const paths = [selection.path];
          if (selectsWhole(selection)) {
            if (target === "stage") [unstaged, staged] = move(paths, unstaged, staged);
            else if (target === "unstage") [staged, unstaged] = move(paths, staged, unstaged);
            else unstaged = unstaged.filter((file) => file.path !== selection.path);
          } else if (target !== "discard") {
            // Part of the file crosses: it is now in both lists.
            const source = target === "stage" ? unstaged : staged;
            const file = source.find((entry) => entry.path === selection.path);
            if (file && target === "stage" && !staged.some((f) => f.path === file.path)) {
              staged = [...staged, file];
            } else if (
              file &&
              target === "unstage" &&
              !unstaged.some((f) => f.path === file.path)
            ) {
              unstaged = [...unstaged, file];
            }
          }
          return null;
        }
        case "commit": {
          if (options.failCommit) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "git.cli_failed",
              message: "git commit failed",
              detail:
                "husky - commit-msg hook exited with code 1 (error)\nsubject must start with a type",
            });
          }
          const committed = byRepo.get(args["repo"] as string);
          if (committed) committed.staged = [];
          else staged = [];
          return { hash: FAKE_COMMIT_HASH };
        }
        case "branch_create":
          if (options.writeErrors?.[args["repo"] as string]) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject(options.writeErrors[args["repo"] as string]);
          }
          return null;
        case "branch_rename":
        case "tag_create":
        case "tag_delete":
        case "set_upstream":
        case "reset":
        case "mark_resolved":
          return null;
        case "switch":
          if (options.writeErrors?.[args["repo"] as string]) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject(options.writeErrors[args["repo"] as string]);
          }
          if (options.dirtySwitch) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "git.cli_failed",
              message: "git switch failed",
              detail:
                "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.ts\nPlease commit your changes or stash them before you switch branches.\nAborting",
            });
          }
          return null;
        case "branch_delete":
          if (options.unmergedBranch && !args["force"]) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "git.cli_failed",
              message: "git branch -d failed",
              detail: `error: the branch '${args["name"] as string}' is not fully merged`,
            });
          }
          return null;
        case "merge":
        case "rebase":
        case "cherry_pick":
        case "revert":
        case "sequencer":
        case "stash_apply":
        case "stash_pop":
          if (options.stashGone) return stashGone(args);
          return (
            options.outcome ?? {
              kind: "done",
              hash: FAKE_OUTCOME_HASH,
              conflicts: [] as Conflict[],
            }
          );
        case "operation_state":
          return options.operation ?? "none";
        case "conflicts":
          return options.conflicts ?? [];
        case "remotes":
          return remotes.map((remote) => ({ ...remote }));
        case "remote_add":
          remotes = [
            ...remotes,
            {
              name: args["name"] as string,
              fetchUrl: args["url"] as string,
              fetchedAt: null,
              pushUrl: args["url"] as string,
            },
          ];
          return null;
        case "remote_remove":
          remotes = remotes.filter((remote) => remote.name !== args["name"]);
          return null;
        case "fetch":
        case "pull":
        case "push": {
          const messages: unknown[] = FAKE_PROGRESS.map((line, seq) => ({
            kind: "page",
            seq,
            data: { kind: "progress", line },
          }));
          const repoError = options.networkErrors?.[args["repo"] as string];
          if (repoError) {
            messages.push({ kind: "error", error: repoError });
          } else if (options.failNetwork) {
            messages.push({
              kind: "error",
              error: {
                code: "git.cli_failed",
                message: "git push failed",
                detail:
                  " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs",
              },
            });
          } else {
            const data =
              cmd === "pull"
                ? {
                    kind: "outcome",
                    outcome: options.outcome ?? {
                      kind: "fast-forward",
                      hash: FAKE_OUTCOME_HASH,
                      conflicts: [],
                    },
                  }
                : { kind: "result", summary: ["   0000000..beef000  main -> main"] };
            messages.push({ kind: "page", seq: FAKE_PROGRESS.length, data }, { kind: "done" });
          }
          if (options.networkDelayMs) {
            // The progress lines arrive at once; the result waits, as a slow link would.
            const progress = messages.slice(0, FAKE_PROGRESS.length);
            send(args["onPage"] as Channel<unknown>, progress);
            send(
              args["onPage"] as Channel<unknown>,
              messages.slice(FAKE_PROGRESS.length),
              options.networkDelayMs,
            );
            return null;
          }
          send(args["onPage"] as Channel<unknown>, messages);
          return null;
        }
        case "stash_push":
          return !options.stashNothing;
        case "stash_drop":
          if (options.stashGone) return stashGone(args);
          return null;
        case "commit_context":
          return {
            author: "Iker Z. <iker@x>",
            template: null,
            headMessage: "fix(auth): commit 0",
            unborn: false,
            operation: "none",
            preparedMessage: null,
            ...options.commitContext,
          } satisfies CommitContext;
        case "refresh_repository": {
          const path = args["path"] as string;
          const failure = options.summaryErrors?.[path];
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
          if (failure) return Promise.reject(failure);
          const summary = options.summaries?.[path];
          if (!summary) return null;
          // A listed repository keeps its row, as the index does; the summary is new.
          const known = options.repositories?.find((entry) => entry.path === path);
          const answer = known ? { ...known, summary } : entryFor(path, summary);
          const delay = options.summaryDelayMs;
          if (delay) return new Promise((resolve) => setTimeout(() => resolve(answer), delay));
          return answer;
        }
        case "watch_repository":
        case "record_repository_open":
        case "unwatch_folder":
          return null;
        case "watch_folder":
          // The first 20 distinct roots but the open repository's, sorted, as the backend answers.
          return [...new Set(args["roots"] as string[])]
            .slice(0, 20)
            .filter((root) => root !== opened)
            .sort();
        case "list_repositories":
          if (options.failIndex) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({ code: "index.database", message: "database is locked" });
          }
          return (options.repositories ?? []).map((entry) => ({ ...entry }));
        case "open_external":
          if (options.missingPaths?.includes(String(args["path"]))) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "external.not_found",
              message: "The path is not on disk",
              detail: String(args["path"]),
            });
          }
          // The argv that ran, as the backend answers: the first template's words.
          return String((args["templates"] as string[] | undefined)?.[0] ?? "").split(" ");
        case "projects":
          if (options.failProjects) return projectFailure();
          return [...projects].sort(byName).map((project) => ({
            ...project,
            members: [...project.members],
          }));
        case "project_create": {
          if (options.failProjects) return projectFailure();
          projectClock += 1;
          const project: Project = {
            id: Math.max(0, ...projects.map((known) => known.id)) + 1,
            name: (args["name"] as string).trim(),
            members: unique(args["paths"] as string[]),
            createdAt: projectClock,
            updatedAt: projectClock,
          };
          projects = [...projects, project];
          return { ...project, members: [...project.members] };
        }
        case "project_rename":
        case "project_set_members": {
          if (options.failProjects) return projectFailure();
          const known = projects.find((project) => project.id === args["id"]);
          if (!known) return null;
          projectClock += 1;
          const changed: Project =
            cmd === "project_rename"
              ? { ...known, name: (args["name"] as string).trim(), updatedAt: projectClock }
              : { ...known, members: unique(args["paths"] as string[]), updatedAt: projectClock };
          projects = projects.map((project) => (project.id === changed.id ? changed : project));
          return { ...changed, members: [...changed.members] };
        }
        case "project_delete": {
          if (options.failProjects) return projectFailure();
          const before = projects.length;
          projects = projects.filter((project) => project.id !== args["id"]);
          return projects.length < before;
        }
        case "app_info":
          return {
            version: "0.1.0",
            logFile: "/home/iker/.local/share/dev.begitra.app/logs/begitra-2026-09-22.log",
            logDir: "/home/iker/.local/share/dev.begitra.app/logs",
          };
        case "close_repository":
        case "close_walk":
        case "cancel_operation":
          return true;
        default:
          throw new Error(`unexpected command ${cmd}`);
      }
    },
    { shouldMockEvents: options.mockEvents ?? false },
  );
  return calls;
}

/** Lets microtasks, the IPC mock and one macrotask run. */
export async function settled(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}
