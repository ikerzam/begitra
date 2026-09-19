// Valibot schemas mirroring the Rust types that cross the IPC boundary (git-core `types.rs`,
// the app's `error.rs`, `channels.rs`, `events.rs` and the command payloads). Every result is
// validated with these at the boundary, and the contract test checks them against the JSON
// fixtures that `cargo test -p begira` writes into `src/ipc/fixtures/`.

import * as v from "valibot";

const int = v.pipe(v.number(), v.integer());
const count = v.pipe(v.number(), v.integer(), v.minValue(0));

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
  "worktree.missing_folder",
  "git.cli_failed",
  "ipc.invalid_argument",
  "op.cancelled",
  "op.timeout",
  "op.unknown_walk",
  "external.spawn_failed",
  "settings.io",
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

export const WalkOptionsSchema = v.object({
  pageSize: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500)),
  order: WalkOrderSchema,
});
export type WalkOptions = v.InferOutput<typeof WalkOptionsSchema>;

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
  totalFiles: count,
  files: v.array(FileChangeSchema),
});
export type DiffPage = v.InferOutput<typeof DiffPageSchema>;

export const WorkingTreeBaseSchema = v.picklist(["head", "index"]);
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
  context: count,
  intraLine: v.boolean(),
});
export type DiffOptions = v.InferOutput<typeof DiffOptionsSchema>;

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

export const RepoChangeKindSchema = v.picklist(["refs", "status", "worktrees", "index"]);
export type RepoChangeKind = v.InferOutput<typeof RepoChangeKindSchema>;

export const RepoChangedSchema = v.object({
  repo: v.string(),
  kinds: v.array(RepoChangeKindSchema),
  paths: v.array(v.string()),
});
export type RepoChanged = v.InferOutput<typeof RepoChangedSchema>;

export const PongSchema = v.object({
  message: v.string(),
  backend: v.string(),
  version: v.string(),
});
export type Pong = v.InferOutput<typeof PongSchema>;

// --- Command arguments ----------------------------------------------------------------------

const opId = v.pipe(v.string(), v.minLength(1));
const path = v.pipe(v.string(), v.minLength(1));

export const commandArgs = {
  ping: v.object({ message: v.string() }),
  cancel_operation: v.object({ opId }),
  debug_emit_repo_changed: v.object({ payload: RepoChangedSchema }),
  open_repository: v.object({ path, opId }),
  close_repository: v.object({ root: path }),
  list_refs: v.object({ repo: path, opId }),
  status: v.object({ repo: path, options: StatusOptionsSchema, opId }),
  merge_base: v.object({ repo: path, a: v.string(), b: v.string(), opId }),
  list_worktrees: v.object({ repo: path, opId }),
  walk_commits: v.object({
    repo: path,
    scope: WalkScopeSchema,
    options: WalkOptionsSchema,
    maxPages: v.pipe(v.number(), v.integer(), v.minValue(1)),
    opId,
  }),
  walk_continue: v.object({
    walkId: v.string(),
    nextIndex: count,
    maxPages: v.pipe(v.number(), v.integer(), v.minValue(1)),
    opId,
  }),
  close_walk: v.object({ walkId: v.string() }),
  diff: v.object({ repo: path, target: DiffTargetSchema, options: DiffOptionsSchema, opId }),
  open_external: v.object({ templates: v.pipe(v.array(v.string()), v.minLength(1)), path }),
} as const;
export type CommandName = keyof typeof commandArgs;
