// Contract test: every JSON fixture written by `cargo test -p begira` (src-tauri/src/fixtures.rs)
// must parse with the schema of its type. A Rust field renamed without updating the schema
// fails here; a fixture without a schema, or a schema without a fixture, fails too.

import * as v from "valibot";
import { describe, expect, it } from "vitest";

import {
  AnnotationSchema,
  AnnotationWriteSchema,
  AppErrorSchema,
  BlobAtSchema,
  BlobContentSchema,
  ChangeSetSchema,
  CommitCountSchema,
  CommitNodeSchema,
  ComparisonSchema,
  GitDetectionSchema,
  MergePreviewSchema,
  DiffOptionsSchema,
  DiffPageSchema,
  HighlightSchema,
  DiffTargetSchema,
  IndexEntrySchema,
  PongSchema,
  RefSchema,
  RepoChangedSchema,
  RepoSchema,
  ScanMessageSchema,
  ScanOptionsSchema,
  StatusEntrySchema,
  StatusOptionsSchema,
  SymbolSchema,
  WalkOptionsSchema,
  WalkPageSchema,
  WalkScopeSchema,
  WorktreeAddSchema,
  WorktreeSchema,
  errorCodes,
  streamMessageSchema,
} from "./schemas";

const fixtures = import.meta.glob("./fixtures/*.json", {
  eager: true,
  import: "default",
});

const schemas: Record<string, v.GenericSchema> = {
  "repo.json": RepoSchema,
  "refs.json": v.array(RefSchema),
  "commit-node.json": CommitNodeSchema,
  "walk-page.json": WalkPageSchema,
  "stream-page.json": streamMessageSchema(WalkPageSchema),
  "stream-done.json": streamMessageSchema(WalkPageSchema),
  "stream-error.json": streamMessageSchema(WalkPageSchema),
  "status-entries.json": v.array(StatusEntrySchema),
  "change-set.json": ChangeSetSchema,
  "diff-page.json": DiffPageSchema,
  "worktrees.json": v.array(WorktreeSchema),
  "worktree-adds.json": v.array(WorktreeAddSchema),
  "git-detection.json": GitDetectionSchema,
  "app-errors.json": v.array(AppErrorSchema),
  "repo-changed.json": RepoChangedSchema,
  "pong.json": PongSchema,
  "commit-count.json": CommitCountSchema,
  "comparison.json": ComparisonSchema,
  "merge-previews.json": v.array(MergePreviewSchema),
  "walk-scopes.json": v.array(WalkScopeSchema),
  "walk-options.json": v.array(WalkOptionsSchema),
  "status-options.json": v.array(StatusOptionsSchema),
  "diff-targets.json": v.array(DiffTargetSchema),
  "diff-options.json": v.array(DiffOptionsSchema),
  "blob-at.json": v.array(BlobAtSchema),
  "blob-contents.json": v.array(BlobContentSchema),
  "highlight.json": HighlightSchema,
  "symbols.json": v.array(SymbolSchema),
  "annotations.json": v.array(AnnotationSchema),
  "annotation-write.json": AnnotationWriteSchema,
  "index-entries.json": v.array(IndexEntrySchema),
  "scan-messages.json": v.array(ScanMessageSchema),
  "scan-stream-page.json": streamMessageSchema(ScanMessageSchema),
  "scan-options.json": v.array(ScanOptionsSchema),
};

function name(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

describe("IPC contract", () => {
  it("has a schema for every fixture and a fixture for every schema", () => {
    const present = Object.keys(fixtures).map(name).sort();
    expect(present).toEqual(Object.keys(schemas).sort());
  });

  for (const [path, data] of Object.entries(fixtures)) {
    it(`${name(path)} matches its schema`, () => {
      const schema = schemas[name(path)];
      expect(schema, `no schema for ${name(path)}`).toBeDefined();
      const result = v.safeParse(schema as v.GenericSchema, data);
      const issues = result.success
        ? []
        : result.issues.map(
            (issue) => `${issue.path?.map((p) => String(p.key)).join(".")}: ${issue.message}`,
          );
      expect(issues).toEqual([]);
    });
  }

  it("lists the same error codes as the backend, in the same order", () => {
    const errors = fixtures["./fixtures/app-errors.json"] as { code: string }[];
    expect(errors.map((error) => error.code)).toEqual([...errorCodes]);
  });

  it("keeps the stream error fixture readable", () => {
    const message = fixtures["./fixtures/stream-error.json"] as {
      kind: string;
      error: { code: string; detail?: string };
    };
    expect(message.kind).toBe("error");
    expect(message.error.code).toBe("repo.corrupt_object");
    expect(message.error.detail).toContain("zlib");
  });
});
