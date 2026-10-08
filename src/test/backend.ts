// A fake Tauri backend for graph tests: a repository whose walk honours the scope and the
// filter the way the engine does, pages of a chosen size, an optional failure after a page,
// counts per scope, empty diffs. Every call is recorded for assertions.

import type { Channel } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";

import { ignoreLine } from "@/changes/ignore";
import { comparePaths, covers } from "@/stores/reloads";

import type {
  Annotation,
  AnnotationWrite,
  BranchToDelete,
  CleanupCandidates,
  CommitContext,
  CommitNode,
  Conflict,
  DiffLine,
  DiffTarget,
  FileChange,
  Hunk,
  IgnorePlace,
  IgnoreRule,
  IndexEntry,
  KeptBy,
  KeptReason,
  MergePreview,
  OperationSides,
  OperationState,
  Outcome,
  PatchSelection,
  Project,
  Ref,
  Remote,
  RepoSummary,
  SelectionTarget,
  UndoOutcome,
  WalkFilter,
  WalkScope,
  Worktree,
  WorktreeAdd,
} from "@/ipc/schemas";

import { changedFile } from "./changes";

export interface Call {
  cmd: string;
  args: Record<string, unknown>;
}

/** Staging writes and commits held until the test lets each one go, oldest first. */
export interface WriteGate {
  /** The commands waiting, oldest first. */
  readonly waiting: string[];
  /** Runs the oldest waiting write, as the backend would have. */
  release(): void;
  /** Refuses the oldest waiting write, as git does while another process holds the index lock. */
  refuse(): void;
  /** For the fake backend: runs `run` once the test lets `cmd` go. */
  hold<T>(cmd: string, run: () => T | Promise<T>): Promise<T>;
}

/** A gate for `writeGate`: the writes wait until `release` or `refuse`. */
export function writeGate(): WriteGate {
  const held: { cmd: string; go: () => void; stop: () => void }[] = [];
  return {
    get waiting() {
      return held.map((entry) => entry.cmd);
    },
    release() {
      held.shift()?.go();
    },
    refuse() {
      held.shift()?.stop();
    },
    hold<T>(cmd: string, run: () => T | Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        held.push({
          cmd,
          go: () => {
            Promise.resolve().then(run).then(resolve, reject);
          },
          stop: () => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            reject({
              code: "git.cli_failed",
              message: "git add failed",
              detail: "fatal: Unable to create '/r/.git/index.lock': File exists.",
            });
          },
        });
      });
    },
  };
}

export interface FakeBackendOptions {
  /** Commits in the repository (subject "commit N", authors cycling). Default 30. */
  commits?: number;
  pageSize?: number;
  /** After this many pages the walk ends with `repo.corrupt_object`, or `walkFailure`. */
  failAfterPages?: number;
  /** The error `failAfterPages` ends the walk with instead of the corrupt object. */
  walkFailure?: { code: string; message: string; detail?: string };
  /**
   * A code search's first pages are empty and not the last, as git's are while it finds nothing
   * for a while; its rows come after them.
   */
  searchEmptyPages?: number;
  /** A code search answers each request after this many milliseconds. */
  searchDelayMs?: number;
  /** Commits a ref scope lists (the first N). Default 10. */
  refScopeCommits?: number;
  /** Every diff fails with `diff.blob_missing`. */
  failDiff?: boolean;
  /** Annotation writes reject. */
  failAnnotations?: boolean;
  /** No agent server beside the app (a development build that did not build it). */
  noAgentServer?: boolean;
  /** `app_info` rejects, so the app cannot tell its version or where its agent server is. */
  failAppInfo?: boolean;
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
  /**
   * What `list_repositories` answers; none by default. A project write that leaves a path in
   * no project takes it out, as the index does.
   */
  repositories?: IndexEntry[];
  /** `list_repositories` rejects with `index.database`. */
  failIndex?: boolean;
  /** Tauri's events go through the mock, so `emit` reaches the app's listeners. */
  mockEvents?: boolean;
  /** Folders `open_repository` refuses with `repo.not_found` (folders of repositories). */
  notRepositories?: string[];
  /** Every staging write rejects with `git.cli_failed` (a stale hunk). */
  failStaging?: boolean;
  /** `ignore_path` rejects with `ignore.write_failed`. */
  failIgnore?: boolean;
  /** The rule `ignore_path` reports as still keeping the file, which then stays listed. */
  ignoreKeptBy?: KeptBy;
  /** `commit` rejects with `git.cli_failed` (a hook's output). */
  failCommit?: boolean;
  /**
   * A discard that asks for a copy rejects with this code and discards nothing, as when the
   * files are past what a copy holds, a folder, or a disk that refuses the copy.
   */
  discardNoCopy?:
    "discard.too_large" | "discard.not_a_file" | "discard.behind_link" | "discard.copy_failed";
  /**
   * A discard that asks for a copy discards only its first path, as git does when it stops on a
   * file another program holds: the copy of that path comes with git's error.
   */
  discardStopsPartWay?: boolean;
  /**
   * What `undo_discard` answers for the paths the copy holds; by default every path comes
   * back. A path it does not answer as restored stays discarded.
   */
  undoOutcome?: (paths: string[]) => UndoOutcome;
  /**
   * Holds each staging write and each commit until the test lets it go: what the lists show
   * before git answers.
   */
  writeGate?: WriteGate;
  /**
   * Holds each `list_refs`, `list_worktrees` and `projects` until the test lets it go, answering
   * as things were when it was asked; set it after the open to hold the listings that follow.
   */
  listingGate?: WriteGate;
  /**
   * What `commit_context` answers, over the defaults (a born branch on HEAD's commit, one
   * parent, no template); `head` gives HEAD's commit until `move_head` moves it.
   */
  commitContext?: Partial<CommitContext>;
  /**
   * `move_head` finds HEAD moved to this commit first (a commit made outside the app) and
   * refuses with `refs.head_moved`.
   */
  headMovesTo?: string;
  /** `commit_context` rejects with this error. */
  commitContextError?: { code: string; message: string; detail?: string };
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
  /** `open_repository` answers a detached HEAD, as on a checked-out commit. */
  detachedHead?: boolean;
  /** The remotes `remotes` answers; `remote_add` and `remote_remove` change the list. */
  remotes?: Remote[];
  /** What the operations that may stop on conflicts answer; done on a new commit by default. */
  outcome?: Outcome;
  /**
   * What `operation_state` and `conflicts` answer; `take_side` takes paths out of the conflicts
   * and `restore_conflicts` puts them back.
   */
  operation?: OperationState;
  conflicts?: Conflict[];
  /** What `operation_sides` answers; `FAKE_SIDES` while an operation is in progress by default. */
  sides?: OperationSides | null;
  /** `operation_sides`, `take_side` and `restore_conflicts` reject with these errors. */
  sideErrors?: {
    sides?: { code: string; message: string; detail?: string };
    take?: { code: string; message: string; detail?: string };
    restore?: { code: string; message: string; detail?: string };
  };
  /**
   * What `cleanup_candidates` answers: `main` and no candidate by default. `delete_branches`
   * takes the branches it deletes out of the candidates and the refs, and their worktrees out of
   * the worktrees.
   */
  cleanup?: CleanupCandidates;
  /** `delete_branches` keeps these branches, by name, with these outcomes. */
  cleanupKept?: Record<
    string,
    { reason: KeptReason; message: string | null; worktreeRemoved?: boolean }
  >;
  /** `cleanup_candidates` and `delete_branches` reject with these errors. */
  cleanupErrors?: {
    list?: { code: string; message: string; detail?: string };
    delete?: { code: string; message: string; detail?: string };
  };
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
  /** `switch`, `branch_create` and `branch_delete` in these repositories reject with these errors. */
  writeErrors?: Record<string, { code: string; message: string; detail?: string }>;
  /** `stash_push` answers false (nothing to save). */
  stashNothing?: boolean;
  /** The projects `projects` answers at start; the project writes change the list. */
  projects?: Project[];
  /** Every project command rejects with `index.database`. */
  failProjects?: boolean;
  /** `project_create_folder` rejects these folders with `index.folder` (not on disk). */
  missingFolders?: string[];
  /**
   * The repository `project_for_path` finds for a path, by path; the path itself otherwise,
   * unless `notRepositories` lists it (`repo.not_found`).
   */
  repositoryOf?: Record<string, string>;
  /** What `read_blob` answers for these paths, as text. */
  blobTexts?: Record<string, string>;
  /** `open_external` and `reveal_path` reject these paths with `external.not_found`, as the
   * backend does for a path that is not on disk. */
  missingPaths?: string[];
  /** `open_link` and `reveal_path` reject with `external.spawn_failed`: the platform refused. */
  failOpener?: boolean;
  /** `remotes` rejects with `git.cli_failed`, as for a broken configuration. */
  failRemotes?: boolean;
  /**
   * What `refs_containing` answers per commit (full ref names); the branches, remote branches
   * and tags whose tip is the commit otherwise. `containingGate` holds each answer until the
   * test lets it go (`refuse` fails it as git would).
   */
  containing?: Record<string, string[]>;
  containingGate?: WriteGate;
  /** `refs_containing` rejects with this error (an `op.timeout` has no detail). */
  containingFailure?: { code: string; message: string; detail?: string };
  /** `open_link` and `reveal_path` reject with `external.refused`, as for a link or a path the
   * backend does not open. */
  refuseOpener?: boolean;
}

/** The hash the operations that move HEAD answer. */
export const FAKE_OUTCOME_HASH = "beef00".padEnd(40, "0");

/** The sides `operation_sides` answers while an operation is in progress: `main` and `develop`. */
export const FAKE_SIDES: OperationSides = {
  ours: { kind: "ref", name: "main" },
  theirs: { kind: "ref", name: "develop" },
};

/** The progress lines every network command streams before its result. */
export const FAKE_PROGRESS = ["Enumerating objects: 12, done.", "Writing objects: 100% (12/12)"];

/** The hash `commit` answers. */
export const FAKE_COMMIT_HASH = "c0ffee".padEnd(40, "0");

/** What `tag_delete` answers the deleted tag pointed at. */
export const FAKE_TAG_OBJECT = "7a90b1".padEnd(40, "0");

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
      bare: false,
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
      bare: false,
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
      bare: false,
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
    // The line from the row above leads into this commit's dot.
    edges:
      n === 0
        ? []
        : [{ fromLane: (n + 2) % 3, toLane: n % 3, parent: n.toString(16).padStart(40, "0") }],
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

/** Removes the resolution of the note at `path` and `hunk` from a target's annotations. */
function dropResolution(list: Annotation[], path: string, hunk: string): void {
  const at = list.findIndex((a) => a.path === path && a.hunk === hunk && a.kind === "resolved");
  if (at >= 0) list.splice(at, 1);
}

export function fakeBackend(options: FakeBackendOptions = {}): Call[] {
  const calls: Call[] = [];
  const total = options.commits ?? 30;
  const pageSize = options.pageSize ?? 500;
  const all = Array.from({ length: total }, (_, i) => fakeCommit(i));
  const annotations: Record<string, Annotation[]> = options.annotations ?? {};
  let worktrees: Worktree[] = (options.worktrees ?? []).map((worktree) => ({ ...worktree }));
  let remotes: Remote[] = (options.remotes ?? []).map((remote) => ({ ...remote }));
  /** The conflicts a side was taken for, by path, which `restore_conflicts` puts back. */
  const taken = new Map<string, Conflict>();
  const copyProject = (project: Project): Project => ({
    ...project,
    members: project.members.map((member) => ({ ...member })),
  });
  let projects: Project[] = (options.projects ?? []).map(copyProject);
  let repositories: IndexEntry[] = (options.repositories ?? []).map((entry) => ({ ...entry }));
  /** The clock of the project writes: one tick per write. */
  let projectClock = 1_704_100_000;
  const byName = (a: Project, b: Project) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id - b.id;
  const unique = (paths: string[]) => [...new Set(paths)];
  const projectFailure = () =>
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
    Promise.reject({ code: "index.database", message: "database is locked" });
  const nextProjectId = () => Math.max(0, ...projects.map((known) => known.id)) + 1;
  /** A path's last segment, whichever separator it uses. */
  const lastSegment = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  /**
   * The membership rule: of `paths`, the ones no project holds any more leave the listing;
   * answers them in their order.
   */
  const dropUnreferenced = (paths: string[]): string[] => {
    const held = new Set(projects.flatMap((project) => project.members.map((m) => m.path)));
    const removed = unique(paths).filter((path) => !held.has(path));
    repositories = repositories.filter((entry) => !removed.includes(entry.path));
    return removed;
  };
  let unstaged: FileChange[] = [...(options.changes?.unstaged ?? [])];
  let staged: FileChange[] = [...(options.changes?.staged ?? [])];
  /** The copy discards keep, as the backend does: one at a time, the last sealed. */
  let copy: { id: string; repo: string; paths: string[]; files: FileChange[] } | null = null;
  let copies = 0;
  /** Keeps the copy of a discard of `paths` in `repo`; `files` are the rows it took away. */
  const keepCopy = (repo: string, paths: string[], files: FileChange[]): string => {
    copies += 1;
    copy = { id: String(copies), repo, paths, files };
    return copy.id;
  };
  const noCopy = () => {
    const code = options.discardNoCopy ?? "discard.copy_failed";
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
    return Promise.reject({
      code,
      message: "No copy of the discarded files could be kept",
      detail:
        code === "discard.not_a_file"
          ? "vendor/tool/"
          : code === "discard.too_large"
            ? "300000000 bytes"
            : "There is not enough space on the disk. (os error 112)",
    });
  };
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
          : scope.kind === "refs" && scope.names.length === 0
            ? []
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
    // The code search finds the text as written in the subject or the body.
    const code = filter.content?.text;
    if (code) listed = listed.filter((c) => c.subject.includes(code) || c.body.includes(code));
    return listed;
  };
  /** What the last `walk_commits` lists, which `walk_continue` goes on with. */
  let walked: { scope: WalkScope; filter: WalkFilter } = { scope: { kind: "all" }, filter: {} };
  /** HEAD's commit once `move_head` moved it; the listing and the context follow. */
  let movedHead: string | null = null;
  /** The refs `list_refs` answers, HEAD and its branch where `move_head` left them. */
  const listRefs = (): Ref[] =>
    listedRefs().map((entry) =>
      movedHead !== null &&
      (entry.kind === "head" || (entry.kind === "local-branch" && entry.isCurrent))
        ? { ...entry, target: movedHead }
        : entry,
    );
  /** HEAD's commit as the context reads it. */
  const currentHead = (): string =>
    movedHead ??
    options.commitContext?.head ??
    listedRefs().find((entry) => entry.kind === "head")?.target ??
    listedRefs().find((entry) => entry.kind === "local-branch" && entry.isCurrent)?.target ??
    fakeCommit(0).hash;
  /** The refs as the test gives them: the test's, or the two local branches. */
  const listedRefs = (): Ref[] =>
    options.refs
      ? options.refs.map((entry) => ({ ...entry }))
      : [
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
            currentBranch: options.detachedHead ? null : "main",
            detached: options.detachedHead ?? false,
            isLinkedWorktree: false,
          };
        }
        case "list_refs": {
          const listed = listRefs();
          return options.listingGate ? options.listingGate.hold(cmd, () => listed) : listed;
        }
        case "walk_commits":
        case "walk_continue": {
          // A continuation lists what the walk it continues was started with.
          if (cmd === "walk_commits") {
            walked = {
              scope: (args["scope"] as WalkScope | undefined) ?? { kind: "all" },
              filter: (args["options"] as { filter?: WalkFilter } | undefined)?.filter ?? {},
            };
          }
          const { scope, filter } = walked;
          const listed = listFor(scope, filter);
          const first = cmd === "walk_commits" ? 0 : (args["nextIndex"] as number);
          const maxPages = args["maxPages"] as number;
          const searching = filter.content !== undefined;
          const emptyPages = searching ? (options.searchEmptyPages ?? 0) : 0;
          const messages: unknown[] = [];
          let seq = 0;
          if (listed.length === 0 && emptyPages === 0) {
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
                error: options.walkFailure ?? {
                  code: "repo.corrupt_object",
                  message: "object 6c1f0ab is missing or corrupt: loose object is corrupt",
                  detail: "error: object file .git/objects/6c/1f0ab is empty",
                },
              });
              send(args["onPage"] as Channel<unknown>, messages);
              return null;
            }
            if (index < emptyPages) {
              const data = { walkId: "w", index, commits: [], done: false };
              messages.push({ kind: "page", seq, data });
              seq += 1;
              continue;
            }
            const start = (index - emptyPages) * pageSize;
            if (start >= listed.length && !(start === 0 && emptyPages > 0)) break;
            const commits = listed.slice(start, start + pageSize);
            const done = start + commits.length >= listed.length;
            messages.push({ kind: "page", seq, data: { walkId: "w", index, commits, done } });
            seq += 1;
            if (done) break;
          }
          messages.push({ kind: "done" });
          send(
            args["onPage"] as Channel<unknown>,
            messages,
            searching ? options.searchDelayMs : undefined,
          );
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
          const text = options.blobTexts?.[path];
          if (text !== undefined) return { size: text.length, isBinary: false, text };
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
          // As the store: another text is another note, which loses the old one's resolution.
          if (write.kind === "note" && list[index]?.value !== stored.value) {
            dropResolution(list, stored.path, stored.hunk);
          }
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
          if (write.kind === "note") dropResolution(list, write.path, write.hunk ?? "");
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
        case "list_worktrees": {
          const listed = worktrees.map((worktree) => ({ ...worktree }));
          return options.listingGate ? options.listingGate.hold(cmd, () => listed) : listed;
        }
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
            bare: false,
          };
          worktrees = [...worktrees, added];
          return { ...added };
        }
        case "worktree_remove": {
          const path = args["path"] as string;
          // As the bridge: the worktree the app has open cannot go.
          if (path === args["repo"]) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "ipc.invalid_argument",
              message: "Invalid argument path",
              detail: "path: the open repository; open another worktree first",
            });
          }
          if (!args["force"] && options.dirtyWorktrees?.includes(path)) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "worktree.dirty",
              message: `the worktree ${path} has uncommitted changes`,
            });
          }
          const removeIt = () => {
            worktrees = worktrees.filter((worktree) => worktree.path !== path);
            return null;
          };
          return options.writeGate ? options.writeGate.hold(cmd, removeIt) : removeIt();
        }
        case "worktree_prune": {
          const pruned = worktrees.filter((worktree) => worktree.prunable).map((w) => w.path);
          worktrees = worktrees.filter((worktree) => !worktree.prunable);
          return pruned;
        }
        case "worktree_lock": {
          const path = args["path"] as string;
          const lock = () => {
            worktrees = worktrees.map((worktree) =>
              worktree.path === path
                ? {
                    ...worktree,
                    locked: true,
                    lockReason: (args["reason"] as string | null) ?? null,
                  }
                : worktree,
            );
            return null;
          };
          return options.writeGate ? options.writeGate.hold(cmd, lock) : lock();
        }
        case "worktree_unlock": {
          const path = args["path"] as string;
          const unlock = () => {
            worktrees = worktrees.map((worktree) =>
              worktree.path === path ? { ...worktree, locked: false, lockReason: null } : worktree,
            );
            return null;
          };
          return options.writeGate ? options.writeGate.hold(cmd, unlock) : unlock();
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
          const stage = () => {
            const own = byRepo.get(args["repo"] as string);
            if (own) {
              [own.unstaged, own.staged] = move(
                args["paths"] as string[],
                own.unstaged,
                own.staged,
              );
              return null;
            }
            [unstaged, staged] = move(args["paths"] as string[], unstaged, staged);
            return null;
          };
          return options.writeGate ? options.writeGate.hold(cmd, stage) : stage();
        }
        case "unstage_paths": {
          if (options.failStaging) return stagingFailure();
          const unstage = () => {
            const own = byRepo.get(args["repo"] as string);
            if (own) {
              [own.staged, own.unstaged] = move(
                args["paths"] as string[],
                own.staged,
                own.unstaged,
              );
              return null;
            }
            [staged, unstaged] = move(args["paths"] as string[], staged, unstaged);
            return null;
          };
          return options.writeGate ? options.writeGate.hold(cmd, unstage) : unstage();
        }
        case "discard_paths": {
          if (options.failStaging) return stagingFailure();
          const kept = args["keepCopy"] === true;
          if (kept && options.discardNoCopy) return noCopy();
          const named = [...(args["tracked"] as string[]), ...(args["untracked"] as string[])];
          // git stops after the first path when asked to.
          const partWay = kept && options.discardStopsPartWay === true;
          const gone = partWay ? named.slice(0, 1) : named;
          const repo = args["repo"] as string;
          const discard = () => {
            const own = byRepo.get(repo);
            const before = own ? own.unstaged : unstaged;
            const after = before.filter((file) => !gone.includes(file.path));
            if (own) own.unstaged = after;
            else unstaged = after;
            const taken = before.filter((file) => gone.includes(file.path));
            return {
              copy: kept ? keepCopy(repo, gone, taken) : null,
              failure: partWay
                ? {
                    code: "git.cli_failed",
                    message: "git restore failed",
                    detail: `error: unable to unlink old '${named[1] ?? ""}': Permission denied`,
                  }
                : null,
            };
          };
          return options.writeGate ? options.writeGate.hold(cmd, discard) : discard();
        }
        case "undo_discard": {
          const repo = args["repo"] as string;
          if (copy === null || copy.id !== args["copy"] || copy.repo !== repo) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "discard.copy_gone",
              message: "The copy of this discard is gone",
            });
          }
          const held = copy;
          const undo = () => {
            const outcome: UndoOutcome = options.undoOutcome?.(held.paths) ?? {
              restored: held.paths,
              changed: [],
              failed: [],
            };
            const back = held.files.filter((file) => outcome.restored.includes(file.path));
            const own = byRepo.get(repo);
            const list = own ? own.unstaged : unstaged;
            const merged = [
              ...list,
              ...back.filter((file) => !list.some((f) => f.path === file.path)),
            ];
            if (own) own.unstaged = merged;
            else unstaged = merged;
            if (outcome.failed.length === 0) copy = null;
            else held.paths = outcome.failed.map((failure) => failure.path);
            return outcome;
          };
          return options.writeGate ? options.writeGate.hold(cmd, undo) : undo();
        }
        case "forget_discard":
          if (copy?.id === args["copy"]) copy = null;
          return null;
        case "ignore_path": {
          if (options.failIgnore) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "ignore.write_failed",
              message: "/r/.gitignore could not be written: Access is denied.",
              detail: "Access is denied.",
            });
          }
          const path = args["path"] as string;
          const rule = args["rule"] as IgnoreRule;
          const place = args["place"] as IgnorePlace;
          const line = ignoreLine(path, rule) ?? "";
          const repo = args["repo"] as string;
          const file = place === "gitignore" ? `${repo}/.gitignore` : `${repo}/.git/info/exclude`;
          if (options.ignoreKeptBy) {
            return { line, file, written: true, ignored: false, keptBy: options.ignoreKeptBy };
          }
          const folder = path.replace(/\/$/, "").split("/").slice(0, -1).join("/");
          const extension = line.slice(1);
          const matches = (candidate: FileChange) =>
            candidate.status === "added" &&
            (rule === "file"
              ? candidate.path === path
              : rule === "extension"
                ? candidate.path.endsWith(extension)
                : candidate.path.startsWith(`${folder}/`));
          // A shared rule's new `.gitignore` shows as an untracked file of its own.
          const after = (list: FileChange[]) => {
            const kept = list.filter((candidate) => !matches(candidate));
            const fresh =
              place === "gitignore" && !kept.some((candidate) => candidate.path === ".gitignore");
            return fresh ? [...kept, changedFile(".gitignore", { status: "added" })] : kept;
          };
          // A folder view's repository has lists of its own.
          const own = byRepo.get(repo);
          if (own) own.unstaged = after(own.unstaged);
          else unstaged = after(unstaged);
          return { line, file, written: true, ignored: true, keptBy: null };
        }
        case "apply_selection": {
          if (options.failStaging) return stagingFailure();
          const selection = args["selection"] as PatchSelection;
          const target = args["target"] as SelectionTarget;
          const paths = [selection.path];
          const kept = args["keepCopy"] === true && target === "discard";
          if (kept && options.discardNoCopy) return noCopy();
          const taken = unstaged.filter((file) => file.path === selection.path);
          const apply = () => {
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
            const repo = args["repo"] as string;
            return { copy: kept ? keepCopy(repo, paths, taken) : null, failure: null };
          };
          return options.writeGate ? options.writeGate.hold(cmd, apply) : apply();
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
          const commit = () => {
            const committed = byRepo.get(args["repo"] as string);
            if (committed) committed.staged = [];
            else staged = [];
            return { hash: FAKE_COMMIT_HASH };
          };
          return options.writeGate ? options.writeGate.hold(cmd, commit) : commit();
        }
        case "branch_create":
          if (options.writeErrors?.[args["repo"] as string]) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject(options.writeErrors[args["repo"] as string]);
          }
          return null;
        case "tag_delete":
          return FAKE_TAG_OBJECT;
        case "branch_rename":
        case "tag_create":
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
          if (options.writeErrors?.[args["repo"] as string]) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject(options.writeErrors[args["repo"] as string]);
          }
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
          return (options.conflicts ?? []).map((conflict) => ({ ...conflict }));
        case "operation_sides":
          if (options.sideErrors?.sides) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject(options.sideErrors.sides);
          }
          if (options.sides !== undefined) return options.sides;
          return (options.operation ?? "none") === "none" ? null : FAKE_SIDES;
        case "take_side": {
          if (options.sideErrors?.take) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject(options.sideErrors.take);
          }
          const paths = args["paths"] as string[];
          const listed = options.conflicts ?? [];
          for (const conflict of listed) {
            if (paths.includes(conflict.path)) taken.set(conflict.path, conflict);
          }
          // A new list on the options, which tests may also replace: the caller's array stays.
          options.conflicts = listed.filter((conflict) => !paths.includes(conflict.path));
          return null;
        }
        case "restore_conflicts": {
          if (options.sideErrors?.restore) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject(options.sideErrors.restore);
          }
          for (const path of args["paths"] as string[]) {
            const conflict = taken.get(path);
            if (!conflict) continue;
            taken.delete(path);
            options.conflicts = [...(options.conflicts ?? []), conflict].sort((a, b) =>
              a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
            );
          }
          return null;
        }
        case "cleanup_candidates": {
          if (options.cleanupErrors?.list) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject(options.cleanupErrors.list);
          }
          const listed = options.cleanup ?? { main: "main", candidates: [] };
          return { main: listed.main, candidates: listed.candidates.map((c) => ({ ...c })) };
        }
        case "delete_branches": {
          if (options.cleanupErrors?.delete) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject(options.cleanupErrors.delete);
          }
          const deleteThem = () =>
            (args["branches"] as BranchToDelete[]).map((branch) => {
              const kept = options.cleanupKept?.[branch.name];
              if (kept) {
                // A branch kept after its worktree went: the worktree leaves the list.
                if (kept.worktreeRemoved && branch.worktree !== null) {
                  worktrees = worktrees.filter((worktree) => worktree.path !== branch.worktree);
                }
                return {
                  name: branch.name,
                  deleted: false,
                  reason: kept.reason,
                  message: kept.message,
                  worktreeRemoved: kept.worktreeRemoved ?? false,
                };
              }
              if (options.cleanup) {
                options.cleanup = {
                  ...options.cleanup,
                  candidates: options.cleanup.candidates.filter((c) => c.name !== branch.name),
                };
              }
              if (options.refs) {
                options.refs = options.refs.filter(
                  (entry) => entry.fullName !== `refs/heads/${branch.name}`,
                );
              }
              if (branch.worktree !== null) {
                worktrees = worktrees.filter((worktree) => worktree.path !== branch.worktree);
              }
              return {
                name: branch.name,
                deleted: true,
                reason: null,
                message: null,
                worktreeRemoved: branch.worktree !== null,
              };
            });
          return options.writeGate ? options.writeGate.hold(cmd, deleteThem) : deleteThem();
        }
        case "refs_containing": {
          const commit = String(args["commit"]);
          if (options.containingFailure) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({ ...options.containingFailure });
          }
          const answer = () =>
            options.containing?.[commit] ??
            listedRefs()
              .filter(
                (entry) =>
                  entry.target === commit &&
                  (entry.kind === "local-branch" ||
                    entry.kind === "remote-branch" ||
                    entry.kind === "tag"),
              )
              .map((entry) => entry.fullName);
          return options.containingGate ? options.containingGate.hold(cmd, answer) : answer();
        }
        case "remotes":
          if (options.failRemotes) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "git.cli_failed",
              message: "git remote exited with 128",
              detail: "fatal: bad config line 3 in file .git/config",
            });
          }
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
        case "commit_context": {
          if (options.commitContextError) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject(options.commitContextError);
          }
          const unborn = options.commitContext?.unborn ?? false;
          const head = unborn ? null : currentHead();
          return {
            author: "Iker Z. <iker@x>",
            template: null,
            headMessage: "fix(auth): commit 0",
            unborn,
            operation: "none",
            otherOperation: null,
            preparedMessage: null,
            ...options.commitContext,
            head,
            // A fake commit's parent is the next one, as `fakeCommit` draws them.
            headParents:
              options.commitContext?.headParents ??
              (head === null ? [] : [(BigInt(`0x${head}`) + 1n).toString(16).padStart(40, "0")]),
          } satisfies CommitContext;
        }
        case "move_head": {
          if (options.headMovesTo !== undefined) movedHead = options.headMovesTo;
          const at = currentHead();
          if (args["from"] !== at) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "refs.head_moved",
              message: `HEAD is at ${at}, not at ${args["from"] as string}`,
            });
          }
          movedHead = args["to"] as string;
          return null;
        }
        case "refresh_repository": {
          const path = args["path"] as string;
          const failure = options.summaryErrors?.[path];
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
          if (failure) return Promise.reject(failure);
          const summary = options.summaries?.[path];
          if (!summary) return null;
          // A listed repository keeps its row, as the index does; the summary is new.
          const known = repositories.find((entry) => entry.path === path);
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
          return repositories.map((entry) => ({ ...entry }));
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
        case "open_link":
        case "reveal_path":
          if (options.refuseOpener) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "external.refused",
              message: "The link is not a forge's page",
              detail: String(args["url"] ?? args["path"]),
            });
          }
          if (options.failOpener) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "external.spawn_failed",
              message: "The browser could not be opened",
              detail: "no handler for https",
            });
          }
          if (cmd === "reveal_path" && options.missingPaths?.includes(String(args["path"]))) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "external.not_found",
              message: "The path is not on disk",
              detail: String(args["path"]),
            });
          }
          return null;
        case "projects": {
          if (options.failProjects) return projectFailure();
          const listed = [...projects].sort(byName).map(copyProject);
          return options.listingGate ? options.listingGate.hold(cmd, () => listed) : listed;
        }
        case "project_create": {
          if (options.failProjects) return projectFailure();
          projectClock += 1;
          const project: Project = {
            id: nextProjectId(),
            name: (args["name"] as string).trim(),
            kind: "list",
            folder: null,
            members: unique(args["paths"] as string[]).map((path) => ({ path, origin: "hand" })),
            pinned: false,
            openedAt: null,
            lastRepository: null,
            createdAt: projectClock,
            updatedAt: projectClock,
          };
          projects = [...projects, project];
          return copyProject(project);
        }
        case "project_create_folder": {
          if (options.failProjects) return projectFailure();
          const folder = args["folder"] as string;
          if (options.missingFolders?.includes(folder)) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({
              code: "index.folder",
              message: "not a folder",
              detail: folder,
            });
          }
          const known = projects.find((project) => project.folder === folder);
          if (known) return copyProject(known);
          projectClock += 1;
          const project: Project = {
            id: nextProjectId(),
            name: lastSegment(folder),
            kind: "folder",
            folder,
            members: [],
            pinned: false,
            openedAt: null,
            lastRepository: null,
            createdAt: projectClock,
            updatedAt: projectClock,
          };
          projects = [...projects, project];
          return copyProject(project);
        }
        case "project_for_path": {
          if (options.failProjects) return projectFailure();
          const path = args["path"] as string;
          if (options.notRepositories?.includes(path)) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({ code: "repo.not_found", message: "not a git repository" });
          }
          const repository = options.repositoryOf?.[path] ?? path;
          const holding = projects
            .filter((project) => project.members.some((member) => member.path === repository))
            .sort((a, b) => (b.openedAt ?? -1) - (a.openedAt ?? -1) || a.id - b.id);
          let project = holding[0];
          if (!project) {
            projectClock += 1;
            project = {
              id: nextProjectId(),
              name: lastSegment(repository),
              kind: "list",
              folder: null,
              members: [{ path: repository, origin: "hand" }],
              pinned: false,
              openedAt: null,
              lastRepository: null,
              createdAt: projectClock,
              updatedAt: projectClock,
            };
            projects = [...projects, project];
          }
          return { project: copyProject(project), repository };
        }
        case "project_rename": {
          if (options.failProjects) return projectFailure();
          const known = projects.find((project) => project.id === args["id"]);
          if (!known) return null;
          projectClock += 1;
          const changed = {
            ...known,
            name: (args["name"] as string).trim(),
            updatedAt: projectClock,
          };
          projects = projects.map((project) => (project.id === changed.id ? changed : project));
          return copyProject(changed);
        }
        case "project_set_members": {
          if (options.failProjects) return projectFailure();
          const known = projects.find((project) => project.id === args["id"]);
          if (!known) return null;
          projectClock += 1;
          // A folder project keeps its folder's own members; the paths replace the hand ones.
          const own = known.members.filter((member) => member.origin === "folder");
          const hand = unique(args["paths"] as string[])
            .filter((path) => !own.some((member) => member.path === path))
            .map((path) => ({ path, origin: "hand" as const }));
          const changed: Project = {
            ...known,
            members: [...own, ...hand],
            updatedAt: projectClock,
          };
          projects = projects.map((project) => (project.id === changed.id ? changed : project));
          const removed = dropUnreferenced(known.members.map((member) => member.path));
          return { project: copyProject(changed), removed };
        }
        case "project_set_pinned": {
          if (options.failProjects) return projectFailure();
          const known = projects.find((project) => project.id === args["id"]);
          if (!known) return false;
          const pinned = args["pinned"] as boolean;
          projects = projects.map((project) =>
            project.id === known.id ? { ...project, pinned } : project,
          );
          return true;
        }
        case "project_record_open": {
          if (options.failProjects) return projectFailure();
          const known = projects.find((project) => project.id === args["id"]);
          if (!known) return false;
          projectClock += 1;
          const repository = (args["repository"] as string | null) ?? known.lastRepository;
          projects = projects.map((project) =>
            project.id === known.id
              ? { ...project, openedAt: projectClock, lastRepository: repository }
              : project,
          );
          return true;
        }
        case "project_delete": {
          if (options.failProjects) return projectFailure();
          const known = projects.find((project) => project.id === args["id"]);
          if (!known) return null;
          projects = projects.filter((project) => project.id !== known.id);
          return dropUnreferenced(known.members.map((member) => member.path));
        }
        case "app_info":
          if (options.failAppInfo) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- serialised AppError
            return Promise.reject({ code: "internal", message: "no app data folder" });
          }
          return {
            version: "0.1.0",
            logFile: "/home/iker/.local/share/dev.begitra.app/logs/begitra-2026-09-22.log",
            logDir: "/home/iker/.local/share/dev.begitra.app/logs",
            agentServer: options.noAgentServer ? null : "/opt/begitra/begitra-mcp",
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
