// Valibot schemas mirroring the Rust types that cross the IPC boundary (git-core `types.rs`,
// the app's `error.rs`, `channels.rs`, `events.rs` and the command payloads). Every result is
// validated with these at the boundary, and the contract test checks them against the JSON
// fixtures that `cargo test -p begitra` writes into `src/ipc/fixtures/`.

import * as v from "valibot";

const int = v.pipe(v.number(), v.integer());
const count = v.pipe(v.number(), v.integer(), v.minValue(0));
/** Pages one walk call may stream; the backend clamps at the same bound. */
const maxPages = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(64));

// --- Errors and streams -------------------------------------------------------------------

export const AppErrorSchema = v.object({
  code: v.string(),
  message: v.string(),
  detail: v.optional(v.string()),
});
export type AppErrorShape = v.InferOutput<typeof AppErrorSchema>;

/** Codes the backend can return, in the order of `codes::ALL` in `src-tauri/src/error.rs`. */
export const errorCodes = [
  "repo.not_found",
  "repo.invalid",
  "repo.corrupt_object",
  "refs.not_found",
  "refs.unrelated_histories",
  "diff.blob_missing",
  "blob.too_large",
  "blob.unreadable",
  "worktree.missing_folder",
  "worktree.dirty",
  "git.not_started",
  "git.cli_failed",
  "stash.not_found",
  "ipc.invalid_argument",
  "op.cancelled",
  "op.timeout",
  "op.unknown_walk",
  "external.spawn_failed",
  "settings.io",
  "index.database",
  "index.folder",
  "watcher.unavailable",
  "updater.failed",
  "internal",
] as const;
export type ErrorCode = (typeof errorCodes)[number];

/** Builds the schema of a stream envelope for pages of `page`. */
export function streamMessageSchema<TPage extends v.GenericSchema>(page: TPage) {
  return v.variant("kind", [
    v.object({ kind: v.literal("page"), seq: count, data: page }),
    v.object({ kind: v.literal("done") }),
    v.object({ kind: v.literal("error"), error: AppErrorSchema }),
  ]);
}

// --- Repository, refs, commits ------------------------------------------------------------

export const RepoSchema = v.object({
  root: v.string(),
  commonDir: v.string(),
  currentBranch: v.nullable(v.string()),
  detached: v.boolean(),
  isLinkedWorktree: v.boolean(),
});
export type Repo = v.InferOutput<typeof RepoSchema>;

export const RefKindSchema = v.picklist(["local-branch", "remote-branch", "tag", "stash", "head"]);
export type RefKind = v.InferOutput<typeof RefKindSchema>;

export const RefSchema = v.object({
  name: v.string(),
  fullName: v.string(),
  kind: RefKindSchema,
  target: v.string(),
  isCurrent: v.boolean(),
  upstream: v.nullable(v.string()),
  ahead: v.nullable(count),
  behind: v.nullable(count),
  worktree: v.nullable(v.string()),
  message: v.nullable(v.string()),
  /**
   * Unix seconds of the committer time of the ref's commit, as `git log -1 --format=%ct <ref>`
   * prints it; null for a tag of a tree or a blob.
   */
  committedAt: v.nullable(int),
});
export type Ref = v.InferOutput<typeof RefSchema>;

export const SignatureSchema = v.object({
  name: v.string(),
  email: v.string(),
  time: int,
  offsetMinutes: int,
});
export type Signature = v.InferOutput<typeof SignatureSchema>;

export const EdgeSchema = v.object({
  fromLane: count,
  toLane: count,
  parent: v.string(),
});
export type Edge = v.InferOutput<typeof EdgeSchema>;

export const CommitNodeSchema = v.object({
  hash: v.string(),
  parents: v.array(v.string()),
  author: SignatureSchema,
  committer: SignatureSchema,
  subject: v.string(),
  body: v.string(),
  refs: v.array(v.string()),
  lane: count,
  edges: v.array(EdgeSchema),
  overflow: count,
});
export type CommitNode = v.InferOutput<typeof CommitNodeSchema>;

export const WalkPageSchema = v.object({
  walkId: v.string(),
  index: count,
  commits: v.array(CommitNodeSchema),
  done: v.boolean(),
});
export type WalkPage = v.InferOutput<typeof WalkPageSchema>;

export const WalkScopeSchema = v.variant("kind", [
  v.object({ kind: v.literal("all") }),
  v.object({ kind: v.literal("ref"), name: v.string() }),
  v.object({ kind: v.literal("range"), exclude: v.string(), include: v.string() }),
]);
export type WalkScope = v.InferOutput<typeof WalkScopeSchema>;

export const WalkOrderSchema = v.picklist(["date-topo", "lazy"]);
export type WalkOrder = v.InferOutput<typeof WalkOrderSchema>;

const filterText = v.pipe(v.string(), v.maxLength(200));

export const WalkFilterSchema = v.object({
  text: v.optional(filterText),
  author: v.optional(filterText),
  since: v.optional(v.number()),
  until: v.optional(v.number()),
  paths: v.optional(v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.maxLength(20))),
});
export type WalkFilter = v.InferOutput<typeof WalkFilterSchema>;

export const WalkOptionsSchema = v.object({
  pageSize: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500)),
  order: WalkOrderSchema,
  filter: v.optional(WalkFilterSchema),
});
export type WalkOptions = v.InferOutput<typeof WalkOptionsSchema>;

export const CommitCountSchema = v.object({ count, capped: v.boolean() });
export type CommitCount = v.InferOutput<typeof CommitCountSchema>;

export const EndpointSchema = v.object({ rev: v.string(), hash: v.string() });
export type Endpoint = v.InferOutput<typeof EndpointSchema>;

export const ComparisonRelationSchema = v.picklist([
  "same",
  "fast-forward",
  "up-to-date",
  "diverged",
]);
export type ComparisonRelation = v.InferOutput<typeof ComparisonRelationSchema>;

/** Two revisions side by side: the base, what each has that the other lacks, the relation. */
export const ComparisonSchema = v.object({
  a: EndpointSchema,
  b: EndpointSchema,
  base: v.object({ hash: v.string(), time: v.number() }),
  onlyInA: count,
  onlyInB: count,
  relation: ComparisonRelationSchema,
});
export type Comparison = v.InferOutput<typeof ComparisonSchema>;

export const MergePreviewKindSchema = v.picklist([
  "fast-forward",
  "up-to-date",
  "clean",
  "conflicts",
]);
export type MergePreviewKind = v.InferOutput<typeof MergePreviewKindSchema>;

/** What merging b into a would do; the paths that would conflict, sorted and unique. */
export const MergePreviewSchema = v.object({
  kind: MergePreviewKindSchema,
  conflicts: v.array(v.string()),
});
export type MergePreview = v.InferOutput<typeof MergePreviewSchema>;

// --- Status -------------------------------------------------------------------------------

export const ChangeKindSchema = v.picklist([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type-changed",
  "unmerged",
]);
export type ChangeKind = v.InferOutput<typeof ChangeKindSchema>;

export const StatusEntrySchema = v.object({
  path: v.string(),
  oldPath: v.nullable(v.string()),
  staged: v.nullable(ChangeKindSchema),
  unstaged: v.nullable(ChangeKindSchema),
  untracked: v.boolean(),
  ignored: v.boolean(),
  conflicted: v.boolean(),
});
export type StatusEntry = v.InferOutput<typeof StatusEntrySchema>;

export const StatusOptionsSchema = v.object({
  includeIgnored: v.boolean(),
  includeUntracked: v.boolean(),
  renames: v.boolean(),
});
export type StatusOptions = v.InferOutput<typeof StatusOptionsSchema>;

// --- Diff ---------------------------------------------------------------------------------

export const SpanSchema = v.object({ start: count, end: count });
export type Span = v.InferOutput<typeof SpanSchema>;

export const LineKindSchema = v.picklist(["context", "added", "removed"]);
export type LineKind = v.InferOutput<typeof LineKindSchema>;

export const DiffLineSchema = v.object({
  kind: LineKindSchema,
  oldNumber: v.nullable(count),
  newNumber: v.nullable(count),
  text: v.string(),
  spans: v.array(SpanSchema),
  noNewline: v.boolean(),
});
export type DiffLine = v.InferOutput<typeof DiffLineSchema>;

export const HunkSchema = v.object({
  oldStart: count,
  oldLines: count,
  newStart: count,
  newLines: count,
  header: v.string(),
  lines: v.array(DiffLineSchema),
});
export type Hunk = v.InferOutput<typeof HunkSchema>;

export const FileChangeSchema = v.object({
  status: ChangeKindSchema,
  path: v.string(),
  oldPath: v.nullable(v.string()),
  similarity: v.nullable(count),
  additions: count,
  deletions: count,
  hunks: v.array(HunkSchema),
  isBinary: v.boolean(),
  isLarge: v.boolean(),
  isGenerated: v.boolean(),
  isTest: v.boolean(),
  isLossy: v.boolean(),
  /** The old side's blob id; null when the file has none. */
  oldId: v.nullable(v.string()),
  /**
   * The new side's id: a blob id, a submodule's commit, or `stat:<size>:<ns>` for a folder
   * and for a working file over 64 MiB that the patch does not read; null when the file has
   * none or it could not be read.
   */
  newId: v.nullable(v.string()),
});
export type FileChange = v.InferOutput<typeof FileChangeSchema>;

export const ChangeSetSchema = v.object({
  files: v.array(FileChangeSchema),
  additions: count,
  deletions: count,
});
export type ChangeSet = v.InferOutput<typeof ChangeSetSchema>;

export const DiffPageSchema = v.object({
  additions: count,
  deletions: count,
  /** An upper bound: the files of the last page (`done`) are the true total. */
  totalFiles: count,
  files: v.array(FileChangeSchema),
});
export type DiffPage = v.InferOutput<typeof DiffPageSchema>;

export const WorkingTreeBaseSchema = v.union([
  v.picklist(["head", "index"]),
  v.object({ revision: v.object({ rev: v.string() }) }),
]);
export type WorkingTreeBase = v.InferOutput<typeof WorkingTreeBaseSchema>;

export const DiffTargetSchema = v.variant("kind", [
  v.object({ kind: v.literal("commit"), hash: v.string() }),
  v.object({ kind: v.literal("commits"), from: v.string(), to: v.string() }),
  v.object({ kind: v.literal("range"), from: v.string(), to: v.string(), threeDot: v.boolean() }),
  v.object({ kind: v.literal("working-tree"), base: WorkingTreeBaseSchema }),
  v.object({ kind: v.literal("index") }),
]);
export type DiffTarget = v.InferOutput<typeof DiffTargetSchema>;

export const DiffOptionsSchema = v.object({
  renames: v.boolean(),
  similarity: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100)),
  /** Context lines around each change; the engine clamps at 1,000. */
  context: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1_000)),
  intraLine: v.boolean(),
  /** Ignore every whitespace change, like `git diff -w`. */
  ignoreWhitespace: v.optional(v.boolean(), false),
});
export type DiffOptions = v.InferOutput<typeof DiffOptionsSchema>;

// --- Review: blobs, highlighting, symbols, annotations ------------------------------------

export const BlobAtSchema = v.variant("kind", [
  v.object({ kind: v.literal("working-tree") }),
  v.object({ kind: v.literal("revision"), rev: v.string() }),
  /** The staged version: the index entry at stage 0. */
  v.object({ kind: v.literal("index") }),
  /** The merge base of two revisions: the old side of `a...b`. */
  v.object({ kind: v.literal("merge-base"), a: v.string(), b: v.string() }),
]);
export type BlobAt = v.InferOutput<typeof BlobAtSchema>;

export const BlobContentSchema = v.object({
  size: count,
  isBinary: v.boolean(),
  text: v.optional(v.string()),
  /** Base64 of a binary file. */
  bytes: v.optional(v.string()),
});
export type BlobContent = v.InferOutput<typeof BlobContentSchema>;

export const TokenClassSchema = v.picklist([
  "plain",
  "comment",
  "string",
  "keyword",
  "number",
  "type",
  "function",
  "punctuation",
]);
export type TokenClass = v.InferOutput<typeof TokenClassSchema>;

export const TokenSchema = v.object({ start: count, end: count, class: TokenClassSchema });
export type Token = v.InferOutput<typeof TokenSchema>;

export const HighlightSchema = v.object({
  syntax: v.nullable(v.string()),
  lines: v.array(v.array(TokenSchema)),
  /** False when the highlighter's time budget ran out: the lines past the last are plain. */
  complete: v.boolean(),
});
export type Highlight = v.InferOutput<typeof HighlightSchema>;

/** A run of lines the viewer shows, 1-based and inclusive. */
export interface LineRange {
  start: number;
  end: number;
}

export const SymbolKindSchema = v.picklist([
  "function",
  "method",
  "class",
  "struct",
  "enum",
  "interface",
  "trait",
  "type",
  "module",
  "impl",
  "property",
  "constructor",
]);
export type SymbolKind = v.InferOutput<typeof SymbolKindSchema>;

export const SymbolSchema = v.object({
  kind: SymbolKindSchema,
  name: v.string(),
  startLine: count,
  endLine: count,
});
export type Symbol = v.InferOutput<typeof SymbolSchema>;

export const AnnotationKindSchema = v.picklist(["reviewed", "note"]);
export type AnnotationKind = v.InferOutput<typeof AnnotationKindSchema>;

export const AnnotationSchema = v.object({
  path: v.string(),
  hunk: v.string(),
  kind: AnnotationKindSchema,
  value: v.string(),
  updatedAt: int,
});
export type Annotation = v.InferOutput<typeof AnnotationSchema>;

export const AnnotationWriteSchema = v.object({
  path: v.pipe(v.string(), v.minLength(1)),
  hunk: v.optional(v.string(), ""),
  kind: AnnotationKindSchema,
  value: v.optional(v.pipe(v.string(), v.maxLength(10_000)), ""),
});
export type AnnotationWrite = v.InferOutput<typeof AnnotationWriteSchema>;

// --- Worktrees, events, misc --------------------------------------------------------------

export const WorktreeSchema = v.object({
  path: v.string(),
  name: v.nullable(v.string()),
  head: v.nullable(v.string()),
  branch: v.nullable(v.string()),
  detached: v.boolean(),
  isMain: v.boolean(),
  locked: v.boolean(),
  lockReason: v.nullable(v.string()),
  prunable: v.boolean(),
});
export type Worktree = v.InferOutput<typeof WorktreeSchema>;

/** The git executable the CLI runs, as detected or confirmed. */
export const GitDetectionSchema = v.object({ path: v.string(), version: v.string() });
export type GitDetection = v.InferOutput<typeof GitDetectionSchema>;

/** What a selection of changed lines is applied to. */
export const SelectionTargetSchema = v.picklist(["stage", "unstage", "discard"]);
export type SelectionTarget = v.InferOutput<typeof SelectionTargetSchema>;

export const SelectedLineSchema = v.object({
  kind: LineKindSchema,
  text: v.string(),
  noNewline: v.boolean(),
  selected: v.boolean(),
});
export type SelectedLine = v.InferOutput<typeof SelectedLineSchema>;

export const SelectedHunkSchema = v.object({
  oldStart: count,
  oldLines: count,
  newStart: count,
  newLines: count,
  lines: v.array(SelectedLineSchema),
});
export type SelectedHunk = v.InferOutput<typeof SelectedHunkSchema>;

/** A selection of hunks and lines of one file. */
export const PatchSelectionSchema = v.object({
  path: v.string(),
  status: ChangeKindSchema,
  lossy: v.boolean(),
  hunks: v.array(SelectedHunkSchema),
});
export type PatchSelection = v.InferOutput<typeof PatchSelectionSchema>;

export const CommitRequestSchema = v.object({
  message: v.string(),
  amend: v.boolean(),
  signoff: v.boolean(),
});
export type CommitRequest = v.InferOutput<typeof CommitRequestSchema>;

export const CommitResultSchema = v.object({ hash: v.string() });
export type CommitResult = v.InferOutput<typeof CommitResultSchema>;

/** The operation a repository is in the middle of. */
export const OperationStateSchema = v.picklist([
  "none",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
]);
export type OperationState = v.InferOutput<typeof OperationStateSchema>;

export const CommitContextSchema = v.object({
  author: v.string(),
  template: v.nullable(v.string()),
  headMessage: v.nullable(v.string()),
  unborn: v.boolean(),
  operation: OperationStateSchema,
  preparedMessage: v.nullable(v.string()),
});
export type CommitContext = v.InferOutput<typeof CommitContextSchema>;

/** What `switch` checks out. */
export const SwitchTargetSchema = v.variant("kind", [
  v.object({ kind: v.literal("branch"), name: v.string() }),
  v.object({ kind: v.literal("detached"), rev: v.string() }),
]);
export type SwitchTarget = v.InferOutput<typeof SwitchTargetSchema>;

export const MergeModeSchema = v.picklist(["default", "ff-only", "no-ff"]);
export type MergeMode = v.InferOutput<typeof MergeModeSchema>;

export const ResetModeSchema = v.picklist(["soft", "mixed", "hard"]);
export type ResetMode = v.InferOutput<typeof ResetModeSchema>;

export const SequencerActionSchema = v.picklist(["continue", "skip", "abort"]);
export type SequencerAction = v.InferOutput<typeof SequencerActionSchema>;

export const OutcomeKindSchema = v.picklist([
  "fast-forward",
  "merged",
  "done",
  "up-to-date",
  "conflicts",
]);
export type OutcomeKind = v.InferOutput<typeof OutcomeKindSchema>;

export const ConflictKindSchema = v.picklist([
  "both-modified",
  "both-added",
  "both-deleted",
  "deleted-by-us",
  "deleted-by-them",
  "added-by-us",
  "added-by-them",
]);
export type ConflictKind = v.InferOutput<typeof ConflictKindSchema>;

export const ConflictSchema = v.object({ path: v.string(), kind: ConflictKindSchema });
export type Conflict = v.InferOutput<typeof ConflictSchema>;

/** How an operation that may stop on conflicts ended. */
export const OutcomeSchema = v.object({
  kind: OutcomeKindSchema,
  hash: v.nullable(v.string()),
  conflicts: v.array(ConflictSchema),
});
export type Outcome = v.InferOutput<typeof OutcomeSchema>;

export const RemoteSchema = v.object({
  name: v.string(),
  fetchUrl: v.string(),
  pushUrl: v.string(),
  /** Unix seconds of the last fetch that named this remote; null when never or unknown. */
  fetchedAt: v.nullable(v.number()),
});
export type Remote = v.InferOutput<typeof RemoteSchema>;

export const PullRequestSchema = v.object({
  remote: v.nullable(v.string()),
  branch: v.nullable(v.string()),
  rebase: v.boolean(),
  /** Move the branch only as a fast-forward, whatever `pull.ff` says; never with `rebase`. */
  ffOnly: v.boolean(),
});
export type PullRequest = v.InferOutput<typeof PullRequestSchema>;

export const PushRequestSchema = v.object({
  remote: v.nullable(v.string()),
  branch: v.nullable(v.string()),
  setUpstream: v.boolean(),
  forceWithLease: v.boolean(),
});
export type PushRequest = v.InferOutput<typeof PushRequestSchema>;

/** One message of a streamed fetch, pull or push: progress lines, then the result. */
export const NetworkEventSchema = v.variant("kind", [
  v.object({ kind: v.literal("progress"), line: v.string() }),
  v.object({ kind: v.literal("result"), summary: v.array(v.string()) }),
  v.object({ kind: v.literal("outcome"), outcome: OutcomeSchema }),
]);
export type NetworkEvent = v.InferOutput<typeof NetworkEventSchema>;

export const StashPushSchema = v.object({
  message: v.nullable(v.string()),
  includeUntracked: v.boolean(),
  paths: v.array(v.string()),
});
export type StashPush = v.InferOutput<typeof StashPushSchema>;

/** What a new worktree checks out. */
export const WorktreeBranchSchema = v.variant("kind", [
  v.object({ kind: v.literal("new"), name: v.string(), start: v.string() }),
  v.object({ kind: v.literal("existing"), name: v.string() }),
  v.object({ kind: v.literal("detached"), rev: v.string() }),
]);
export type WorktreeBranch = v.InferOutput<typeof WorktreeBranchSchema>;

export const WorktreeAddSchema = v.object({
  path: v.string(),
  branch: WorktreeBranchSchema,
});
export type WorktreeAdd = v.InferOutput<typeof WorktreeAddSchema>;

export const RepoChangeKindSchema = v.picklist(["refs", "status", "worktrees", "index"]);
export type RepoChangeKind = v.InferOutput<typeof RepoChangeKindSchema>;

export const RepoChangedSchema = v.object({
  repo: v.string(),
  kinds: v.array(RepoChangeKindSchema),
  paths: v.array(v.string()),
  /**
   * With `index`: the paths whose index entries changed since the watcher's last snapshot (none
   * for a rewrite that only refreshed stat data), or null when the index could not be compared.
   * Absent from the debug command's payloads, as the backend defaults it.
   */
  indexPaths: v.optional(v.nullable(v.array(v.string())), null),
  /** With `index`: whether an unmerged entry came, went or changed (true when unknown). */
  conflictsChanged: v.optional(v.boolean(), false),
});
export type RepoChanged = v.InferOutput<typeof RepoChangedSchema>;

export const RepoKindSchema = v.picklist(["main", "worktree"]);
export type RepoKind = v.InferOutput<typeof RepoKindSchema>;

export const RepoSummarySchema = v.object({
  currentBranch: v.nullable(v.string()),
  detached: v.boolean(),
  /**
   * The branch's upstream: the tracking ref's short name (`origin/main`), the remote a pull
   * fetches from and a push sends to (`.` for a local upstream), and the branch on it; null
   * without one.
   */
  upstream: v.nullable(v.object({ name: v.string(), remote: v.string(), branch: v.string() })),
  ahead: v.nullable(count),
  behind: v.nullable(count),
  /** The operation in progress; null until a summary has read it. */
  operation: v.nullable(OperationStateSchema),
  /** Unix seconds of the working tree's last fetch; null before any. */
  fetchedAt: v.nullable(v.number()),
  lastCommitAt: v.nullable(v.number()),
  /** The tip's subject; null when unborn or until a summary has read it. */
  lastCommitSubject: v.nullable(v.string()),
  dirty: v.nullable(v.boolean()),
});
export type RepoSummary = v.InferOutput<typeof RepoSummarySchema>;

export const IndexEntrySchema = v.object({
  path: v.string(),
  name: v.string(),
  kind: RepoKindSchema,
  parentPath: v.nullable(v.string()),
  scanRoot: v.nullable(v.string()),
  summary: RepoSummarySchema,
  pinned: v.boolean(),
  lastOpenedAt: v.nullable(v.number()),
  refreshedAt: v.nullable(v.number()),
  missing: v.boolean(),
});
export type IndexEntry = v.InferOutput<typeof IndexEntrySchema>;

/** A named, ordered group of repositories and worktrees, kept by path. */
export const ProjectSchema = v.object({
  id: v.pipe(v.number(), v.integer()),
  name: v.string(),
  /** Member paths in the user's order; a path need not have an index entry. */
  members: v.array(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});
export type Project = v.InferOutput<typeof ProjectSchema>;

export const ScanOptionsSchema = v.object({
  skip: v.array(v.string()),
  maxDepth: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(32)),
});
export type ScanOptions = v.InferOutput<typeof ScanOptionsSchema>;

export const ScanMessageSchema = v.variant("kind", [
  v.object({ kind: v.literal("folder-started"), folder: v.string() }),
  v.object({ kind: v.literal("progress"), folder: v.string(), scanned: count, found: count }),
  v.object({ kind: v.literal("found"), entry: IndexEntrySchema }),
  v.object({ kind: v.literal("updated"), entry: IndexEntrySchema }),
  v.object({
    kind: v.literal("folder-done"),
    folder: v.string(),
    found: count,
    missing: v.array(v.string()),
  }),
  v.object({ kind: v.literal("folder-error"), folder: v.string(), reason: v.string() }),
]);
export type ScanMessage = v.InferOutput<typeof ScanMessageSchema>;

export const PongSchema = v.object({
  message: v.string(),
  backend: v.string(),
  version: v.string(),
});
export type Pong = v.InferOutput<typeof PongSchema>;

/** The version and the log file's location (null while the log stays on the console). */
export const AppInfoSchema = v.object({
  version: v.string(),
  logFile: v.nullable(v.string()),
  logDir: v.nullable(v.string()),
});
export type AppInfo = v.InferOutput<typeof AppInfoSchema>;

// --- Command arguments ----------------------------------------------------------------------

const opId = v.pipe(v.string(), v.minLength(1));
const path = v.pipe(v.string(), v.minLength(1));
/** A revision as an endpoint: not empty, at most 200 characters, never shaped like an option. */
const revision = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(200),
  v.check((rev) => !rev.startsWith("-"), "starts with a dash"),
);
/** A worktree's folder: absolute on the backend's side too; at most 4,096 characters here. */
const worktreePath = v.pipe(
  path,
  v.maxLength(4096),
  v.check((p) => !p.startsWith("-"), "starts with a dash"),
);
/** A path as the status reports it: relative, inside the repository, never option-shaped. */
const repoPath = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(4096),
  v.check((p) => !p.startsWith("/") && !p.startsWith("\\") && !/^[A-Za-z]:/.test(p), "absolute"),
  v.check((p) => !p.split(/[/\\]/).includes(".."), "has `..`"),
);
/** One to 10,000 repository paths. */
const repoPaths = v.pipe(v.array(repoPath), v.minLength(1), v.maxLength(10_000));
/** A commit message with a subject, at most 100,000 characters. */
const commitMessage = v.pipe(
  v.string(),
  v.maxLength(100_000),
  v.check((m) => m.split("\n").some((line) => line.trim() !== ""), "no subject"),
);
/** A lock reason: at most 200 characters, never shaped like an option. */
const lockReason = v.pipe(
  v.string(),
  v.maxLength(200),
  v.check((reason) => !reason.trimStart().startsWith("-"), "starts with a dash"),
);
/** A branch, tag or remote name as git accepts it for a new ref (the backend checks the rest). */
const refName = v.pipe(
  revision,
  v.check((name) => !/[\s~^:?*[\\]/.test(name) && !name.includes(".."), "not a ref name"),
  v.check((name) => !name.endsWith("/") && !name.endsWith("."), "ends with a slash or a dot"),
);
/** A remote URL or path: at most 2,048 characters, never shaped like an option. */
const remoteUrl = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(2048),
  v.check((url) => !url.startsWith("-"), "starts with a dash"),
);
/** A project's name: not blank, at most 100 characters, on one line. */
const projectName = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(100),
  v.check((name) => !/[\u0000-\u001f\u007f-\u009f]/.test(name), "a control character"),
);
const projectId = v.pipe(v.number(), v.integer());
/** At most 500 member paths. */
const memberPaths = v.pipe(v.array(path), v.maxLength(500));
/** One to 100 revisions for a cherry-pick or a revert. */
const revisions = v.pipe(v.array(revision), v.minLength(1), v.maxLength(100));
/** A stash is named by its full commit hash, lowercase, as the refs listing gives it. */
const stashCommit = v.pipe(
  v.string(),
  v.regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "not a full commit hash"),
);
/** A tag message with a line, at most 10,000 characters. */
const tagMessage = v.pipe(
  v.string(),
  v.maxLength(10_000),
  v.check((m) => m.split("\n").some((line) => line.trim() !== ""), "blank"),
);

export const commandArgs = {
  ping: v.object({ message: v.string() }),
  app_info: v.object({}),
  cancel_operation: v.object({ opId }),
  debug_emit_repo_changed: v.object({ payload: RepoChangedSchema }),
  open_repository: v.object({ path, opId }),
  close_repository: v.object({ root: path }),
  list_refs: v.object({ repo: path, opId }),
  status: v.object({ repo: path, options: StatusOptionsSchema, opId }),
  merge_base: v.object({ repo: path, a: v.string(), b: v.string(), opId }),
  compare: v.object({ repo: path, a: revision, b: revision, opId }),
  merge_preview: v.object({ repo: path, a: revision, b: revision, opId }),
  worktree_add: v.object({
    repo: path,
    request: v.object({
      path: worktreePath,
      branch: v.variant("kind", [
        v.object({ kind: v.literal("new"), name: revision, start: revision }),
        v.object({ kind: v.literal("existing"), name: revision }),
        v.object({ kind: v.literal("detached"), rev: revision }),
      ]),
    }),
    opId,
  }),
  worktree_remove: v.object({ repo: path, path: worktreePath, force: v.boolean(), opId }),
  worktree_prune: v.object({ repo: path, opId }),
  worktree_lock: v.object({
    repo: path,
    path: worktreePath,
    reason: v.nullable(lockReason),
    opId,
  }),
  worktree_unlock: v.object({ repo: path, path: worktreePath, opId }),
  path_exists: v.object({ path: worktreePath }),
  stage_paths: v.object({ repo: path, paths: repoPaths, opId }),
  unstage_paths: v.object({ repo: path, paths: repoPaths, opId }),
  discard_paths: v.object({
    repo: path,
    tracked: v.array(repoPath),
    untracked: v.array(repoPath),
    opId,
  }),
  apply_selection: v.object({
    repo: path,
    target: SelectionTargetSchema,
    selection: v.pipe(
      PatchSelectionSchema,
      v.check(
        (s) => s.hunks.some((h) => h.lines.some((l) => l.selected && l.kind !== "context")),
        "no selected line",
      ),
    ),
    opId,
  }),
  commit: v.object({
    repo: path,
    request: v.object({ message: commitMessage, amend: v.boolean(), signoff: v.boolean() }),
    opId,
  }),
  commit_context: v.object({ repo: path, opId }),
  branch_create: v.object({
    repo: path,
    name: refName,
    start: revision,
    checkout: v.boolean(),
    opId,
  }),
  switch: v.object({
    repo: path,
    target: v.variant("kind", [
      v.object({ kind: v.literal("branch"), name: refName }),
      v.object({ kind: v.literal("detached"), rev: revision }),
    ]),
    opId,
  }),
  branch_rename: v.object({ repo: path, from: refName, to: refName, opId }),
  branch_delete: v.object({ repo: path, name: refName, force: v.boolean(), opId }),
  merge: v.object({ repo: path, rev: revision, mode: MergeModeSchema, opId }),
  rebase: v.object({ repo: path, onto: revision, opId }),
  reset: v.object({ repo: path, rev: revision, mode: ResetModeSchema, opId }),
  cherry_pick: v.object({ repo: path, revs: revisions, opId }),
  revert: v.object({ repo: path, revs: revisions, opId }),
  tag_create: v.object({
    repo: path,
    name: refName,
    rev: revision,
    message: v.nullable(tagMessage),
    opId,
  }),
  tag_delete: v.object({ repo: path, name: refName, opId }),
  set_upstream: v.object({ repo: path, branch: refName, upstream: v.nullable(refName), opId }),
  operation_state: v.object({ repo: path, opId }),
  conflicts: v.object({ repo: path, opId }),
  mark_resolved: v.object({ repo: path, paths: repoPaths, opId }),
  sequencer: v.object({ repo: path, action: SequencerActionSchema, opId }),
  remotes: v.object({ repo: path, opId }),
  remote_add: v.object({ repo: path, name: refName, url: remoteUrl, opId }),
  remote_remove: v.object({ repo: path, name: refName, opId }),
  fetch: v.object({
    repo: path,
    remote: v.nullable(refName),
    prune: v.boolean(),
    batch: v.boolean(),
    opId,
  }),
  pull: v.object({
    repo: path,
    request: v.pipe(
      v.object({
        remote: v.nullable(refName),
        branch: v.nullable(refName),
        rebase: v.boolean(),
        ffOnly: v.boolean(),
      }),
      v.check((request) => !(request.rebase && request.ffOnly), "a rebase and a fast-forward only"),
    ),
    batch: v.boolean(),
    opId,
  }),
  push: v.object({
    repo: path,
    request: v.object({
      remote: v.nullable(refName),
      branch: v.nullable(refName),
      setUpstream: v.boolean(),
      forceWithLease: v.boolean(),
    }),
    batch: v.boolean(),
    opId,
  }),
  stash_push: v.object({
    repo: path,
    request: v.object({
      message: v.nullable(v.pipe(v.string(), v.maxLength(10_000))),
      includeUntracked: v.boolean(),
      paths: v.array(repoPath),
    }),
    opId,
  }),
  stash_apply: v.object({ repo: path, stash: stashCommit, opId }),
  stash_pop: v.object({ repo: path, stash: stashCommit, opId }),
  stash_drop: v.object({ repo: path, stash: stashCommit, opId }),
  detect_git: v.object({ opId }),
  set_git_executable: v.object({
    path: v.pipe(
      v.string(),
      v.maxLength(4096),
      v.check((p) => !p.trimStart().startsWith("-"), "starts with a dash"),
    ),
    opId,
  }),
  count_commits: v.object({ repo: path, scope: WalkScopeSchema, opId }),
  list_worktrees: v.object({ repo: path, opId }),
  walk_commits: v.object({
    repo: path,
    scope: WalkScopeSchema,
    options: WalkOptionsSchema,
    maxPages,
    opId,
  }),
  walk_continue: v.object({
    walkId: v.string(),
    nextIndex: count,
    maxPages,
    opId,
  }),
  close_walk: v.object({ walkId: v.string() }),
  diff: v.object({ repo: path, target: DiffTargetSchema, options: DiffOptionsSchema, opId }),
  diff_paths: v.object({
    repo: path,
    target: DiffTargetSchema,
    paths: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1), v.maxLength(200)),
    options: DiffOptionsSchema,
    opId,
  }),
  read_blob: v.object({
    repo: path,
    at: BlobAtSchema,
    path: v.pipe(v.string(), v.minLength(1)),
    opId,
  }),
  highlight_file: v.object({
    repo: path,
    at: BlobAtSchema,
    path: v.pipe(v.string(), v.minLength(1)),
    ranges: v.nullable(
      v.array(v.object({ start: v.pipe(count, v.minValue(1)), end: v.pipe(count, v.minValue(1)) })),
    ),
    opId,
  }),
  file_symbols: v.object({
    repo: path,
    at: BlobAtSchema,
    path: v.pipe(v.string(), v.minLength(1)),
    opId,
  }),
  list_annotations: v.object({ repo: path, target: v.pipe(v.string(), v.minLength(1)) }),
  set_annotation: v.object({
    repo: path,
    target: v.pipe(v.string(), v.minLength(1)),
    annotation: AnnotationWriteSchema,
  }),
  delete_annotation: v.object({
    repo: path,
    target: v.pipe(v.string(), v.minLength(1)),
    annotation: AnnotationWriteSchema,
  }),
  open_external: v.object({ templates: v.pipe(v.array(v.string()), v.minLength(1)), path }),
  watch_repository: v.object({ root: path }),
  watch_folder: v.object({ roots: v.array(path) }),
  unwatch_folder: v.object({}),
  list_repositories: v.object({}),
  pin_repository: v.object({ path, pinned: v.boolean() }),
  forget_repository: v.object({ path }),
  record_repository_open: v.object({ path }),
  refresh_repository: v.object({ path, dirty: v.boolean(), opId }),
  remove_scan_root: v.object({ root: path }),
  projects: v.object({}),
  project_create: v.object({ name: projectName, paths: memberPaths }),
  project_rename: v.object({ id: projectId, name: projectName }),
  project_set_members: v.object({ id: projectId, paths: memberPaths }),
  project_delete: v.object({ id: projectId }),
  scan_folders: v.object({
    folders: v.array(path),
    options: ScanOptionsSchema,
    opId,
  }),
} as const;
export type CommandName = keyof typeof commandArgs;
