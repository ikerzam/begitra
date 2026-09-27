//! Writes one JSON fixture per IPC type into `src/ipc/fixtures/`, where the Vitest contract
//! test (`src/ipc/contract.test.ts`) validates each one against the frontend schema.
//!
//! `cargo test -p begitra` regenerates the files; commit them. CI fails when they differ from
//! the committed ones, so a Rust type cannot change without the frontend noticing.

use std::fs;
use std::path::{Path, PathBuf};

use git_core::types::{
    BaseCommit, BlobAt, BlobContent, ChangeKind, ChangeSet, CommitContext, CommitCount, CommitNode,
    CommitRequest, Comparison, ComparisonRelation, Conflict, ConflictKind, DiffLine, DiffOptions,
    DiffTarget, Edge, Endpoint, FileChange, GitDetection, Hunk, LineKind, MergeMode, MergePreview,
    MergePreviewKind, OperationState, Outcome, OutcomeKind, PatchSelection, PullRequest,
    PushRequest, Ref, RefKind, Remote, Repo, ResetMode, SelectedHunk, SelectedLine,
    SequencerAction, Signature, Span, StashPush, StatusEntry, StatusOptions, SwitchTarget,
    WalkFilter, WalkOptions, WalkOrder, WalkScope, WorkingTreeBase, Worktree, WorktreeAdd,
    WorktreeBranch,
};
use serde::Serialize;
use syntax::{Highlight, Symbol, SymbolKind, Token, TokenClass};

use repo_index::{
    Annotation, AnnotationKind, IndexEntry, Operation as IndexOperation, Project, RepoKind,
    RepoSummary as IndexSummary, ScanOptions,
};

use crate::channels::StreamMessage;
use crate::commands::diff::DiffPage;
use crate::commands::remotes::NetworkEvent;
use crate::commands::review::AnnotationWrite;
use crate::commands::scan::ScanMessage;
use crate::commands::staging::CommitResult;
use crate::commands::system::{app_info_from, pong};
use crate::commands::walk::WalkPage;
use crate::error::{codes, AppError};
use crate::events::{RepoChangeKind, RepoChanged};

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/ipc/fixtures")
}

fn write<T: Serialize>(name: &str, value: &T) {
    let dir = fixtures_dir();
    fs::create_dir_all(&dir).expect("create fixtures dir");
    let mut json = serde_json::to_string_pretty(value).expect("serialise fixture");
    json.push('\n');
    fs::write(dir.join(format!("{name}.json")), json).expect("write fixture");
}

fn signature(name: &str, time: i64) -> Signature {
    Signature {
        name: name.to_owned(),
        email: format!("{}@example.com", name.to_lowercase()),
        time,
        offset_minutes: 120,
    }
}

fn hash(n: u8) -> String {
    format!("{:0>40}", format!("{n:x}"))
}

fn commit(n: u8, parents: &[u8], lane: u32) -> CommitNode {
    CommitNode {
        hash: hash(n),
        parents: parents.iter().map(|p| hash(*p)).collect(),
        author: signature("Iker", 1_704_067_200 + i64::from(n) * 60),
        committer: signature("Iker", 1_704_067_260 + i64::from(n) * 60),
        subject: format!("feat: commit {n}"),
        body: if n.is_multiple_of(2) {
            "Body paragraph.\n\nSecond paragraph.".to_owned()
        } else {
            String::new()
        },
        refs: if n == 1 {
            vec![
                "HEAD".to_owned(),
                "main".to_owned(),
                "origin/main".to_owned(),
            ]
        } else {
            vec![]
        },
        lane,
        edges: parents
            .iter()
            .enumerate()
            .map(|(i, p)| Edge {
                from_lane: lane,
                to_lane: lane + u32::try_from(i).unwrap_or(0),
                parent: hash(*p),
            })
            .collect(),
        overflow: 0,
    }
}

fn repo() -> Repo {
    Repo {
        root: PathBuf::from("/home/iker/code/begitra"),
        common_dir: PathBuf::from("/home/iker/code/begitra/.git"),
        current_branch: Some("main".to_owned()),
        detached: false,
        is_linked_worktree: false,
    }
}

fn refs() -> Vec<Ref> {
    let base = Ref {
        name: "main".to_owned(),
        full_name: "refs/heads/main".to_owned(),
        kind: RefKind::LocalBranch,
        target: hash(1),
        is_current: true,
        upstream: Some("origin/main".to_owned()),
        ahead: Some(2),
        behind: Some(3),
        worktree: Some(PathBuf::from("/home/iker/code/begitra")),
        message: None,
        committed_at: Some(1_700_000_000),
    };
    vec![
        base.clone(),
        Ref {
            name: "origin/main".to_owned(),
            full_name: "refs/remotes/origin/main".to_owned(),
            kind: RefKind::RemoteBranch,
            is_current: false,
            upstream: None,
            ahead: None,
            behind: None,
            worktree: None,
            ..base.clone()
        },
        Ref {
            name: "docs-tree".to_owned(),
            full_name: "refs/tags/docs-tree".to_owned(),
            kind: RefKind::Tag,
            target: hash(4),
            is_current: false,
            upstream: None,
            ahead: None,
            behind: None,
            worktree: None,
            message: None,
            committed_at: None,
        },
        Ref {
            name: "v1.0".to_owned(),
            full_name: "refs/tags/v1.0".to_owned(),
            kind: RefKind::Tag,
            target: hash(2),
            is_current: false,
            upstream: None,
            ahead: None,
            behind: None,
            worktree: None,
            message: Some("Release 1.0".to_owned()),
            committed_at: Some(1_699_000_000),
        },
        Ref {
            name: "stash@{0}".to_owned(),
            full_name: "refs/stash".to_owned(),
            kind: RefKind::Stash,
            target: hash(3),
            is_current: false,
            upstream: None,
            ahead: None,
            behind: None,
            worktree: None,
            message: Some("WIP on main: tidy".to_owned()),
            committed_at: Some(1_700_100_000),
        },
        Ref {
            name: "HEAD".to_owned(),
            full_name: "HEAD".to_owned(),
            kind: RefKind::Head,
            upstream: None,
            ahead: None,
            behind: None,
            worktree: None,
            ..base
        },
    ]
}

fn status_entries() -> Vec<StatusEntry> {
    let blank = StatusEntry {
        path: String::new(),
        old_path: None,
        staged: None,
        unstaged: None,
        untracked: false,
        ignored: false,
        conflicted: false,
    };
    vec![
        StatusEntry {
            path: "src/new.rs".to_owned(),
            staged: Some(ChangeKind::Added),
            ..blank.clone()
        },
        StatusEntry {
            path: "README.md".to_owned(),
            unstaged: Some(ChangeKind::Modified),
            ..blank.clone()
        },
        StatusEntry {
            path: "src/core.rs".to_owned(),
            old_path: Some("src/lib.rs".to_owned()),
            staged: Some(ChangeKind::Renamed),
            ..blank.clone()
        },
        StatusEntry {
            path: "notes.txt".to_owned(),
            untracked: true,
            ..blank.clone()
        },
        StatusEntry {
            path: "build.log".to_owned(),
            ignored: true,
            ..blank.clone()
        },
        StatusEntry {
            path: "src/conflict.rs".to_owned(),
            unstaged: Some(ChangeKind::Unmerged),
            conflicted: true,
            ..blank
        },
    ]
}

fn change_set() -> ChangeSet {
    let hunk = Hunk {
        old_start: 10,
        old_lines: 3,
        new_start: 10,
        new_lines: 4,
        header: "@@ -10,3 +10,4 @@ fn main()".to_owned(),
        lines: vec![
            DiffLine {
                kind: LineKind::Context,
                old_number: Some(10),
                new_number: Some(10),
                text: "fn main() {".to_owned(),
                spans: vec![],
                no_newline: false,
            },
            DiffLine {
                kind: LineKind::Removed,
                old_number: Some(11),
                new_number: None,
                text: "    let x = 1;".to_owned(),
                spans: vec![Span { start: 12, end: 13 }],
                no_newline: false,
            },
            DiffLine {
                kind: LineKind::Added,
                old_number: None,
                new_number: Some(11),
                text: "    let x = 2;".to_owned(),
                spans: vec![Span { start: 12, end: 13 }],
                no_newline: false,
            },
            DiffLine {
                kind: LineKind::Added,
                old_number: None,
                new_number: Some(12),
                text: "    let y = x;".to_owned(),
                spans: vec![],
                no_newline: false,
            },
            DiffLine {
                kind: LineKind::Context,
                old_number: Some(12),
                new_number: Some(13),
                text: "}".to_owned(),
                spans: vec![],
                no_newline: true,
            },
        ],
    };
    ChangeSet {
        files: vec![
            FileChange {
                status: ChangeKind::Renamed,
                path: "src/core.rs".to_owned(),
                old_path: Some("src/lib.rs".to_owned()),
                old_id: Some("3b18e512dba79e4c8300dd08aeb37f8e728b8dad".to_owned()),
                new_id: Some("6c8fb7bd8a6f5e7b9ab4c1e2f0d3a5b7c9e1f203".to_owned()),
                similarity: Some(92),
                additions: 2,
                deletions: 1,
                hunks: vec![hunk],
                is_binary: false,
                is_large: false,
                is_generated: false,
                is_test: false,
                is_lossy: false,
            },
            FileChange {
                status: ChangeKind::Added,
                path: "assets/logo.png".to_owned(),
                old_path: None,
                old_id: None,
                new_id: Some("9f2c4d1e7a3b5c6d8e0f1a2b3c4d5e6f7a8b9c0d".to_owned()),
                similarity: None,
                additions: 0,
                deletions: 0,
                hunks: vec![],
                is_binary: true,
                is_large: false,
                is_generated: false,
                is_test: false,
                is_lossy: false,
            },
            FileChange {
                status: ChangeKind::Modified,
                path: "pnpm-lock.yaml".to_owned(),
                old_path: None,
                old_id: Some("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678".to_owned()),
                new_id: Some("e5d4c3b2a1f0e9d8c7b6a5948372615049382716".to_owned()),
                similarity: None,
                additions: 6_000,
                deletions: 5_900,
                hunks: vec![],
                is_binary: false,
                is_large: true,
                is_generated: true,
                is_test: false,
                is_lossy: false,
            },
            FileChange {
                status: ChangeKind::Deleted,
                path: "tests/old.test.ts".to_owned(),
                old_path: None,
                old_id: Some("4f3e2d1c0b0a09f8e7d6c5b4a3928170615243f0".to_owned()),
                new_id: None,
                similarity: None,
                additions: 0,
                deletions: 40,
                hunks: vec![],
                is_binary: false,
                is_large: false,
                is_generated: false,
                is_test: true,
                is_lossy: false,
            },
        ],
        additions: 6_002,
        deletions: 5_941,
    }
}

fn worktrees() -> Vec<Worktree> {
    vec![
        Worktree {
            path: PathBuf::from("/home/iker/code/begitra"),
            name: None,
            head: Some(hash(1)),
            branch: Some("main".to_owned()),
            detached: false,
            is_main: true,
            locked: false,
            lock_reason: None,
            prunable: false,
        },
        Worktree {
            path: PathBuf::from("/wt/claude-auth"),
            name: Some("claude-auth".to_owned()),
            head: Some(hash(4)),
            branch: Some("claude/fix-auth".to_owned()),
            detached: false,
            is_main: false,
            locked: true,
            lock_reason: Some("agent running".to_owned()),
            prunable: false,
        },
        Worktree {
            path: PathBuf::from("/wt/gone"),
            name: Some("gone".to_owned()),
            head: Some(hash(5)),
            branch: None,
            detached: true,
            is_main: false,
            locked: false,
            lock_reason: None,
            prunable: true,
        },
    ]
}

fn walk_page() -> WalkPage {
    WalkPage {
        walk_id: "walk-1".to_owned(),
        index: 0,
        commits: vec![
            commit(1, &[2, 3], 0),
            commit(2, &[4], 0),
            commit(3, &[4], 1),
        ],
        done: false,
    }
}

fn selections() -> Vec<PatchSelection> {
    let line = |kind: LineKind, text: &str, selected: bool| SelectedLine {
        kind,
        text: text.to_owned(),
        no_newline: false,
        selected,
    };
    let hunk = SelectedHunk {
        old_start: 10,
        old_lines: 3,
        new_start: 10,
        new_lines: 4,
        lines: vec![
            line(LineKind::Context, "fn main() {", false),
            line(LineKind::Removed, "    let x = 1;", true),
            line(LineKind::Added, "    let x = 2;", true),
            line(LineKind::Added, "    let y = 3;", false),
            line(LineKind::Context, "}", false),
        ],
    };
    vec![
        PatchSelection {
            path: "src/main.rs".to_owned(),
            status: ChangeKind::Modified,
            lossy: false,
            hunks: vec![hunk.clone()],
        },
        PatchSelection {
            path: "dir with space/ünïcödé.txt".to_owned(),
            status: ChangeKind::Added,
            lossy: true,
            hunks: vec![hunk],
        },
    ]
}

fn app_errors() -> Vec<AppError> {
    codes::ALL
        .iter()
        .map(|code| {
            let error = AppError::new(code, format!("Sample message for {code}"));
            if matches!(*code, codes::GIT_CLI_FAILED | codes::REPO_CORRUPT_OBJECT) {
                error.with_detail("fatal: raw output")
            } else {
                error
            }
        })
        .collect()
}

fn index_entry(name: &str, kind: RepoKind, parent: Option<&str>) -> IndexEntry {
    IndexEntry {
        path: PathBuf::from(format!("/home/iker/code/{name}")),
        name: name.to_owned(),
        kind,
        parent_path: parent.map(|p| PathBuf::from(format!("/home/iker/code/{p}"))),
        scan_root: Some(PathBuf::from("/home/iker/code")),
        summary: IndexSummary {
            current_branch: Some("main".to_owned()),
            detached: false,
            upstream: Some("origin/main".to_owned()),
            ahead: Some(2),
            behind: Some(0),
            operation: Some(if kind == RepoKind::Main {
                IndexOperation::None
            } else {
                IndexOperation::Rebase
            }),
            fetched_at: (kind == RepoKind::Main).then_some(1_704_069_000),
            last_commit_at: Some(1_704_067_200),
            last_commit_subject: Some("feat(map): stream tiles through a worker".to_owned()),
            dirty: Some(true),
        },
        pinned: kind == RepoKind::Main,
        last_opened_at: Some(1_704_070_000),
        refreshed_at: Some(1_704_070_100),
        missing: false,
    }
}

fn scan_messages() -> Vec<ScanMessage> {
    let folder = PathBuf::from("/home/iker/code");
    vec![
        ScanMessage::FolderStarted {
            folder: folder.clone(),
        },
        ScanMessage::Progress {
            folder: folder.clone(),
            scanned: 312,
            found: 14,
        },
        ScanMessage::Found {
            entry: IndexEntry {
                summary: IndexSummary::default(),
                pinned: false,
                last_opened_at: None,
                refreshed_at: None,
                ..index_entry("geoportal", RepoKind::Main, None)
            },
        },
        ScanMessage::Updated {
            entry: index_entry("geoportal", RepoKind::Main, None),
        },
        ScanMessage::FolderDone {
            folder: folder.clone(),
            found: 14,
            missing: vec![PathBuf::from("/home/iker/code/gone")],
        },
        ScanMessage::FolderError {
            folder: PathBuf::from("/home/iker/wt"),
            reason: "The system cannot find the path specified. (os error 3)".to_owned(),
        },
    ]
}

/// Regenerates every fixture. Deterministic, so a clean checkout produces no diff.
/// The branch, history, network and stash types: what `switch`, the outcomes, the conflicts, the remotes, the network
/// requests and events, and a stash push carry.
fn write_phase7() {
    let conflicts = vec![
        Conflict {
            path: "apps/api/src/auth/middleware.ts".to_owned(),
            kind: ConflictKind::BothModified,
        },
        Conflict {
            path: "apps/api/src/auth/refresh.ts".to_owned(),
            kind: ConflictKind::DeletedByThem,
        },
        Conflict {
            path: "docs/auth.md".to_owned(),
            kind: ConflictKind::BothAdded,
        },
    ];
    write(
        "switch-targets",
        &[
            SwitchTarget::Branch {
                name: "claude/fix-auth".to_owned(),
            },
            SwitchTarget::Detached {
                rev: "v2.3.1".to_owned(),
            },
        ],
    );
    write(
        "merge-modes",
        &[MergeMode::Default, MergeMode::FfOnly, MergeMode::NoFf],
    );
    write(
        "reset-modes",
        &[ResetMode::Soft, ResetMode::Mixed, ResetMode::Hard],
    );
    write(
        "sequencer-actions",
        &[
            SequencerAction::Continue,
            SequencerAction::Skip,
            SequencerAction::Abort,
        ],
    );
    write(
        "operation-states",
        &[
            OperationState::None,
            OperationState::Merge,
            OperationState::Rebase,
            OperationState::CherryPick,
            OperationState::Revert,
        ],
    );
    write(
        "outcomes",
        &[
            Outcome {
                kind: OutcomeKind::FastForward,
                hash: Some("9f3e2c1a7b5d4e6f8a0b1c2d3e4f5a6b7c8d9e0f".to_owned()),
                conflicts: Vec::new(),
            },
            Outcome {
                kind: OutcomeKind::Merged,
                hash: Some("a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4".to_owned()),
                conflicts: Vec::new(),
            },
            Outcome {
                kind: OutcomeKind::Done,
                hash: Some("7f8e9d0a1b2c3d4e5f67890a1b2c3d4e5f678901".to_owned()),
                conflicts: Vec::new(),
            },
            Outcome {
                kind: OutcomeKind::UpToDate,
                hash: None,
                conflicts: Vec::new(),
            },
            Outcome {
                kind: OutcomeKind::Conflicts,
                hash: None,
                conflicts: conflicts.clone(),
            },
        ],
    );
    write("conflicts", &conflicts);
    write(
        "remotes",
        &[
            Remote {
                name: "origin".to_owned(),
                fetch_url: "git@github.com:ikerzam/geoportal.git".to_owned(),
                push_url: "git@github.com:ikerzam/geoportal.git".to_owned(),
                fetched_at: Some(1_758_499_200),
            },
            Remote {
                name: "upstream".to_owned(),
                fetch_url: "https://github.com/geoportal/geoportal.git".to_owned(),
                push_url: "https://github.com/geoportal/geoportal.git".to_owned(),
                fetched_at: None,
            },
        ],
    );
    write(
        "pull-requests",
        &[
            PullRequest {
                remote: None,
                branch: None,
                rebase: false,
                ff_only: true,
            },
            PullRequest {
                remote: Some("origin".to_owned()),
                branch: Some("main".to_owned()),
                rebase: true,
                ff_only: false,
            },
        ],
    );
    write(
        "push-requests",
        &[
            PushRequest {
                remote: None,
                branch: None,
                set_upstream: false,
                force_with_lease: false,
            },
            PushRequest {
                remote: Some("origin".to_owned()),
                branch: Some("claude/fix-auth".to_owned()),
                set_upstream: true,
                force_with_lease: true,
            },
        ],
    );
    write(
        "network-events",
        &[
            StreamMessage::Page {
                seq: 0,
                data: NetworkEvent::Progress {
                    line: "Enumerating objects: 12, done.".to_owned(),
                },
            },
            StreamMessage::Page {
                seq: 1,
                data: NetworkEvent::Progress {
                    line: "Writing objects:  50% (6/12)".to_owned(),
                },
            },
            StreamMessage::Page {
                seq: 2,
                data: NetworkEvent::Result {
                    summary: vec![
                        "   9f3e2c1..a1b2c3d  claude/fix-auth -> claude/fix-auth".to_owned(),
                        " * [new branch]      feature/tile-cache -> feature/tile-cache".to_owned(),
                    ],
                },
            },
            StreamMessage::Page {
                seq: 3,
                data: NetworkEvent::Outcome {
                    outcome: Outcome {
                        kind: OutcomeKind::Conflicts,
                        hash: None,
                        conflicts: conflicts.clone(),
                    },
                },
            },
            StreamMessage::Done,
        ],
    );
    write(
        "stash-pushes",
        &[
            StashPush {
                message: None,
                include_untracked: false,
                paths: Vec::new(),
            },
            StashPush {
                message: Some("wip: tiles".to_owned()),
                include_untracked: true,
                paths: vec!["apps/web/src/map/tile-cache.ts".to_owned()],
            },
        ],
    );
}

#[test]
fn write_fixtures() {
    write("repo", &repo());
    write(
        "index-entries",
        &[
            index_entry("geoportal", RepoKind::Main, None),
            index_entry("claude-auth", RepoKind::Worktree, Some("geoportal")),
        ],
    );
    write("scan-messages", &scan_messages());
    write(
        "projects",
        &[
            Project {
                id: 1,
                name: "geoportal".to_owned(),
                members: vec![
                    PathBuf::from("/home/iker/code/geoportal"),
                    PathBuf::from("/home/iker/code/claude-auth"),
                    PathBuf::from("/home/iker/wt/gone"),
                ],
                created_at: 1_704_060_000,
                updated_at: 1_704_070_000,
            },
            Project {
                id: 2,
                name: "empty".to_owned(),
                members: Vec::new(),
                created_at: 1_704_080_000,
                updated_at: 1_704_080_000,
            },
        ],
    );
    write(
        "scan-stream-page",
        &StreamMessage::Page {
            seq: 3,
            data: ScanMessage::Progress {
                folder: PathBuf::from("/home/iker/code"),
                scanned: 5_000,
                found: 50,
            },
        },
    );
    write(
        "scan-options",
        &[
            ScanOptions::default(),
            ScanOptions {
                skip: vec!["node_modules".to_owned()],
                max_depth: 3,
            },
        ],
    );
    write("refs", &refs());
    write("commit-node", &commit(1, &[2, 3], 0));
    write("walk-page", &walk_page());
    write(
        "stream-page",
        &StreamMessage::Page {
            seq: 0,
            data: walk_page(),
        },
    );
    write("stream-done", &StreamMessage::<WalkPage>::Done);
    write(
        "stream-error",
        &StreamMessage::<WalkPage>::Error {
            error: AppError::new(codes::REPO_CORRUPT_OBJECT, "object abc is corrupt")
                .with_detail("zlib: incorrect header check"),
        },
    );
    write("status-entries", &status_entries());
    write("change-set", &change_set());
    write(
        "diff-page",
        &DiffPage {
            additions: 6_002,
            deletions: 5_941,
            total_files: 4,
            files: change_set().files,
        },
    );
    write("worktrees", &worktrees());
    write(
        "git-detection",
        &GitDetection {
            path: PathBuf::from("/usr/bin/git"),
            version: "git version 2.46.0".to_owned(),
        },
    );
    write(
        "worktree-adds",
        &[
            WorktreeAdd {
                path: PathBuf::from("/wt/claude-auth"),
                branch: WorktreeBranch::New {
                    name: "claude/fix-auth".to_owned(),
                    start: "main".to_owned(),
                },
            },
            WorktreeAdd {
                path: PathBuf::from("/wt/develop"),
                branch: WorktreeBranch::Existing {
                    name: "develop".to_owned(),
                },
            },
            WorktreeAdd {
                path: PathBuf::from("/wt/v1"),
                branch: WorktreeBranch::Detached {
                    rev: "v1".to_owned(),
                },
            },
        ],
    );
    write("selections", &selections());
    write(
        "commit-requests",
        &[
            CommitRequest {
                message: "feat(auth): refresh tokens\n\nThe body.\n".to_owned(),
                amend: false,
                signoff: false,
            },
            CommitRequest {
                message: "fix: typo".to_owned(),
                amend: true,
                signoff: true,
            },
        ],
    );
    write(
        "commit-result",
        &CommitResult {
            hash: "9f3e2c1a7b5d4e6f8a0b1c2d3e4f5a6b7c8d9e0f".to_owned(),
        },
    );
    write(
        "commit-contexts",
        &[
            CommitContext {
                author: "Iker Z. <iker@example.com>".to_owned(),
                template: Some("# subject\n\n# body\n".to_owned()),
                head_message: Some("feat(auth): refresh tokens\n\nThe body.".to_owned()),
                unborn: false,
                operation: OperationState::None,
                prepared_message: None,
            },
            CommitContext {
                author: "Iker Z. <iker@example.com>".to_owned(),
                template: None,
                head_message: None,
                unborn: true,
                operation: OperationState::None,
                prepared_message: None,
            },
            CommitContext {
                author: "Iker Z. <iker@example.com>".to_owned(),
                template: None,
                head_message: Some("main readme".to_owned()),
                unborn: false,
                operation: OperationState::Merge,
                prepared_message: Some(
                    "Merge branch 'other'\n\n# Conflicts:\n#\tREADME.md".to_owned(),
                ),
            },
        ],
    );
    write("app-errors", &app_errors());
    write_phase7();
    write(
        "repo-changed",
        &RepoChanged {
            repo: PathBuf::from("/home/iker/code/begitra"),
            kinds: vec![
                RepoChangeKind::Refs,
                RepoChangeKind::Index,
                RepoChangeKind::Status,
            ],
            paths: vec!["src/main.rs".to_owned()],
            index_paths: Some(vec!["src/lib.rs".to_owned()]),
            conflicts_changed: false,
        },
    );
    write("pong", &pong("hello".to_owned()));
    write(
        "app-info",
        &[
            // A POSIX path: `Path::parent` splits on `\` only on Windows, so a Windows path
            // here would make the fixture different on every other platform.
            app_info_from(Some(PathBuf::from(
                "/home/iker/.local/share/dev.begitra.app/logs/begitra-2026-09-22.log",
            ))),
            app_info_from(None),
        ],
    );
    write(
        "commit-count",
        &CommitCount {
            count: 100_000,
            capped: true,
        },
    );
    write(
        "comparison",
        &Comparison {
            a: Endpoint {
                rev: "main".to_owned(),
                hash: "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4".to_owned(),
            },
            b: Endpoint {
                rev: "claude/fix-auth".to_owned(),
                hash: "9f3e21b0a1b2c3d4e5f67890a1b2c3d4e5f67890".to_owned(),
            },
            base: BaseCommit {
                hash: "7f8e9d0a1b2c3d4e5f67890a1b2c3d4e5f678901".to_owned(),
                time: 1_726_000_000,
            },
            only_in_a: 4,
            only_in_b: 3,
            relation: ComparisonRelation::Diverged,
        },
    );
    write(
        "merge-previews",
        &[
            MergePreview {
                kind: MergePreviewKind::Conflicts,
                conflicts: vec![
                    "apps/api/src/auth/middleware.ts".to_owned(),
                    "apps/api/src/auth/refresh.ts".to_owned(),
                    "apps/api/src/index.ts".to_owned(),
                ],
            },
            MergePreview {
                kind: MergePreviewKind::FastForward,
                conflicts: Vec::new(),
            },
            MergePreview {
                kind: MergePreviewKind::Clean,
                conflicts: Vec::new(),
            },
            MergePreview {
                kind: MergePreviewKind::UpToDate,
                conflicts: Vec::new(),
            },
        ],
    );
    write(
        "walk-scopes",
        &[
            WalkScope::All,
            WalkScope::Ref {
                name: "main".to_owned(),
            },
            WalkScope::Range {
                exclude: "v1.0".to_owned(),
                include: "main".to_owned(),
            },
        ],
    );
    write(
        "walk-options",
        &[
            WalkOptions::default(),
            WalkOptions {
                page_size: 100,
                order: WalkOrder::Lazy,
                filter: None,
            },
            WalkOptions {
                page_size: 500,
                order: WalkOrder::Lazy,
                filter: Some(WalkFilter {
                    text: Some("auth".to_owned()),
                    author: Some("claude".to_owned()),
                    since: Some(1_704_067_200),
                    until: Some(1_735_689_600),
                    paths: vec!["apps/api".to_owned()],
                }),
            },
        ],
    );
    write(
        "status-options",
        &[
            StatusOptions::default(),
            StatusOptions {
                include_ignored: true,
                include_untracked: false,
                renames: false,
            },
        ],
    );
    write(
        "diff-targets",
        &[
            DiffTarget::Commit { hash: hash(1) },
            DiffTarget::Commits {
                from: hash(2),
                to: hash(1),
            },
            DiffTarget::Range {
                from: "main".to_owned(),
                to: "feature".to_owned(),
                three_dot: true,
            },
            DiffTarget::WorkingTree {
                base: WorkingTreeBase::Head,
            },
            DiffTarget::WorkingTree {
                base: WorkingTreeBase::Index,
            },
            DiffTarget::WorkingTree {
                base: WorkingTreeBase::Revision {
                    rev: "v1".to_owned(),
                },
            },
            DiffTarget::Index,
        ],
    );
    write(
        "diff-options",
        &[
            DiffOptions::default(),
            DiffOptions {
                renames: false,
                similarity: 70,
                context: 0,
                intra_line: false,
                ignore_whitespace: true,
            },
        ],
    );
    write(
        "blob-at",
        &[
            BlobAt::WorkingTree,
            BlobAt::Revision {
                rev: "HEAD".to_owned(),
            },
            BlobAt::Index,
            BlobAt::MergeBase {
                a: "main".to_owned(),
                b: "feature/tiles".to_owned(),
            },
        ],
    );
    write(
        "blob-contents",
        &[
            BlobContent {
                size: 6,
                is_binary: false,
                text: Some("hello\n".to_owned()),
                bytes: None,
            },
            BlobContent {
                size: 5,
                is_binary: true,
                text: None,
                bytes: Some("iVBORwA=".to_owned()),
            },
        ],
    );
    write(
        "highlight",
        &Highlight {
            syntax: Some("Rust".to_owned()),
            lines: vec![
                vec![Token {
                    start: 0,
                    end: 7,
                    class: TokenClass::Comment,
                }],
                vec![],
                vec![
                    Token {
                        start: 0,
                        end: 2,
                        class: TokenClass::Keyword,
                    },
                    Token {
                        start: 3,
                        end: 7,
                        class: TokenClass::Function,
                    },
                    Token {
                        start: 10,
                        end: 13,
                        class: TokenClass::String,
                    },
                    Token {
                        start: 14,
                        end: 16,
                        class: TokenClass::Number,
                    },
                    Token {
                        start: 16,
                        end: 17,
                        class: TokenClass::Punctuation,
                    },
                    Token {
                        start: 18,
                        end: 21,
                        class: TokenClass::Type,
                    },
                    Token {
                        start: 21,
                        end: 22,
                        class: TokenClass::Punctuation,
                    },
                ],
            ],
            complete: true,
        },
    );
    write(
        "symbols",
        &[
            Symbol {
                kind: SymbolKind::Struct,
                name: "Foo".to_owned(),
                start_line: 1,
                end_line: 1,
            },
            Symbol {
                kind: SymbolKind::Impl,
                name: "Clone for Foo".to_owned(),
                start_line: 3,
                end_line: 6,
            },
            Symbol {
                kind: SymbolKind::Method,
                name: "clone".to_owned(),
                start_line: 4,
                end_line: 5,
            },
            Symbol {
                kind: SymbolKind::Function,
                name: "main".to_owned(),
                start_line: 8,
                end_line: 12,
            },
            Symbol {
                kind: SymbolKind::Class,
                name: "A".to_owned(),
                start_line: 1,
                end_line: 3,
            },
            Symbol {
                kind: SymbolKind::Enum,
                name: "E".to_owned(),
                start_line: 1,
                end_line: 1,
            },
            Symbol {
                kind: SymbolKind::Interface,
                name: "I".to_owned(),
                start_line: 1,
                end_line: 1,
            },
            Symbol {
                kind: SymbolKind::Trait,
                name: "T".to_owned(),
                start_line: 1,
                end_line: 1,
            },
            Symbol {
                kind: SymbolKind::Type,
                name: "Alias".to_owned(),
                start_line: 1,
                end_line: 1,
            },
            Symbol {
                kind: SymbolKind::Module,
                name: "m".to_owned(),
                start_line: 1,
                end_line: 3,
            },
            Symbol {
                kind: SymbolKind::Property,
                name: "P".to_owned(),
                start_line: 2,
                end_line: 2,
            },
            Symbol {
                kind: SymbolKind::Constructor,
                name: "A".to_owned(),
                start_line: 2,
                end_line: 2,
            },
        ],
    );
    write(
        "annotations",
        &[
            Annotation {
                path: "src/a.ts".to_owned(),
                hunk: String::new(),
                kind: AnnotationKind::Reviewed,
                value: "1".to_owned(),
                updated_at: 1_700_000_000,
            },
            Annotation {
                path: "src/a.ts".to_owned(),
                hunk: "@@ -1,2 +1,3 @@".to_owned(),
                kind: AnnotationKind::Reviewed,
                value: "1".to_owned(),
                updated_at: 1_700_000_001,
            },
            Annotation {
                path: "src/a.ts".to_owned(),
                hunk: String::new(),
                kind: AnnotationKind::Note,
                value: "Check eviction when the worker pool is saturated.".to_owned(),
                updated_at: 1_700_000_002,
            },
        ],
    );
    write(
        "annotation-write",
        &AnnotationWrite {
            path: "src/a.ts".to_owned(),
            hunk: String::new(),
            kind: AnnotationKind::Note,
            value: "note".to_owned(),
        },
    );
}
