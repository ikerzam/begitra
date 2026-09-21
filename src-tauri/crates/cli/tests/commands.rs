//! `begira-cli` against a fixture repository: every command's JSON equals what the engine
//! answers for the same operation, and the streams end with their done line.

use std::path::{Path, PathBuf};
use std::process::Command;

use begira_cli::main_with;
use git_core::engine::{Cancel, GitEngine};
use git_core::git2_engine::Git2Engine;
use git_core::types::{BlobAt, DiffOptions, DiffTarget, StatusOptions, WalkScope, WorkingTreeBase};
use serde_json::Value;
use tempfile::TempDir;

/// A small repository built with the git CLI: two commits on `main`, a `topic` branch one
/// commit ahead, a tag, a linked worktree and a dirty working tree.
struct Fixture {
    _dir: TempDir,
    root: PathBuf,
    clock: i64,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::Builder::new()
            .prefix("begira-cli-")
            .tempdir()
            .expect("temp dir");
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).expect("repo folder");
        let mut fixture = Self {
            _dir: dir,
            root,
            clock: 1_704_067_200,
        };
        fixture.git(&["init", "-q", "-b", "main"]);
        fixture.git(&["config", "user.name", "Fixture"]);
        fixture.git(&["config", "user.email", "fixture@example.com"]);
        fixture.git(&["config", "commit.gpgsign", "false"]);
        fixture.git(&["config", "core.autocrlf", "false"]);
        fixture.write("README.md", "# Fixture\n");
        fixture.commit("c1: readme");
        fixture.write("src/lib.rs", "pub fn one() -> u32 {\n    1\n}\n");
        fixture.commit("c2: lib");
        fixture.git(&["tag", "v1"]);
        fixture.git(&["switch", "-q", "-c", "topic"]);
        fixture.write("src/lib.rs", "pub fn one() -> u32 {\n    2\n}\n");
        fixture.commit("t1: two");
        fixture.git(&["switch", "-q", "main"]);
        let linked = fixture.root.with_file_name("repo-topic");
        fixture.git(&[
            "worktree",
            "add",
            "-q",
            linked.to_str().expect("utf-8"),
            "topic",
        ]);
        fixture.write("README.md", "# Fixture\nedited\n");
        fixture.write("new.txt", "new\n");
        fixture
    }

    fn write(&self, relative: &str, content: &str) {
        let path = self.root.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("folder");
        }
        std::fs::write(path, content).expect("write");
    }

    fn commit(&mut self, message: &str) {
        self.clock += 60;
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", message]);
    }

    fn git(&self, args: &[&str]) -> String {
        let date = format!("{} +0000", self.clock);
        let output = Command::new("git")
            .args(args)
            .current_dir(&self.root)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.root.join("no-global-config"))
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .env("LC_ALL", "C")
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn engine(&self) -> Git2Engine {
        Git2Engine::open(&self.root).expect("open")
    }

    fn path(&self) -> &str {
        self.root.to_str().expect("utf-8")
    }
}

/// Runs the CLI in-process; returns the status, stdout and stderr.
fn cli(args: &[&str]) -> (i32, String, String) {
    let args: Vec<String> = args.iter().map(|s| (*s).to_owned()).collect();
    let mut out = Vec::new();
    let mut err = Vec::new();
    let status = main_with(&args, &mut out, &mut err);
    (
        status,
        String::from_utf8(out).expect("utf-8 stdout"),
        String::from_utf8(err).expect("utf-8 stderr"),
    )
}

fn json(text: &str) -> Value {
    serde_json::from_str(text.trim()).unwrap_or_else(|error| panic!("{error}: {text}"))
}

fn lines(text: &str) -> Vec<Value> {
    text.lines().map(json).collect()
}

fn same<T: serde::Serialize>(engine_value: &T) -> Value {
    serde_json::to_value(engine_value).expect("serialise")
}

#[test]
fn single_documents_equal_the_engine_and_pretty_indents() {
    let f = Fixture::new();
    let e = f.engine();
    let never = Cancel::never();
    let (status, out, err) = cli(&["open", f.path()]);
    assert_eq!((status, err.as_str()), (0, ""));
    assert_eq!(json(&out), same(e.repo()));
    let (_, out, _) = cli(&["refs", f.path()]);
    assert_eq!(json(&out), same(&e.refs(&never).expect("refs")));
    assert!(out.contains("\"topic\""));
    let (_, out, _) = cli(&["status", f.path()]);
    assert_eq!(
        json(&out),
        same(&e.status(&StatusOptions::default(), &never).expect("status"))
    );
    assert!(out.contains("new.txt"));
    let (_, out, _) = cli(&["compare", f.path(), "main", "topic"]);
    assert_eq!(
        json(&out),
        same(&e.compare("main", "topic", &never).expect("compare"))
    );
    let (_, out, _) = cli(&["worktrees", f.path()]);
    assert_eq!(json(&out), same(&e.worktrees(&never).expect("worktrees")));
    assert!(out.contains("repo-topic"));
    let (_, out, _) = cli(&["blob", f.path(), "src/lib.rs", "--rev", "topic"]);
    let at = BlobAt::Revision {
        rev: "topic".to_owned(),
    };
    assert_eq!(
        json(&out),
        same(&e.read_blob(&at, "src/lib.rs").expect("blob"))
    );
    assert!(out.contains("    2"));
    let (_, out, _) = cli(&["blob", f.path(), "README.md"]);
    assert_eq!(
        json(&out),
        same(
            &e.read_blob(&BlobAt::WorkingTree, "README.md")
                .expect("blob")
        )
    );
    assert!(out.contains("edited"));
    let (_, pretty, _) = cli(&["refs", f.path(), "--pretty"]);
    assert!(pretty.lines().count() > 3, "{pretty}");
    assert_eq!(json(&pretty), json(&cli(&["refs", f.path()]).1));
}

#[test]
fn log_streams_pages_then_done_and_honours_the_limit() {
    let f = Fixture::new();
    let (status, out, err) = cli(&["log", f.path()]);
    assert_eq!((status, err.as_str()), (0, ""));
    let pages = lines(&out);
    assert_eq!(pages.len(), 2, "{out}");
    assert_eq!(pages[0]["kind"], "page");
    assert_eq!(pages[0]["done"], true);
    assert_eq!(pages[0]["commits"].as_array().map(Vec::len), Some(3));
    assert_eq!(pages[1], serde_json::json!({ "kind": "done" }));
    let (_, out, _) = cli(&["log", f.path(), "--limit", "2", "--branch", "main"]);
    let pages = lines(&out);
    assert_eq!(pages[0]["commits"].as_array().map(Vec::len), Some(2));
    assert_eq!(pages[0]["commits"][0]["subject"], "c2: lib");
    assert_eq!(pages[0]["done"], true);
    assert_eq!(pages[1]["kind"], "done");
    // The page holds what the engine's walk holds.
    let e = f.engine();
    let mut walk = e
        .walk(
            &WalkScope::Ref {
                name: "main".to_owned(),
            },
            &git_core::types::WalkOptions::default(),
            &Cancel::never(),
        )
        .expect("walk");
    let page = walk.next_page(&Cancel::never()).expect("page");
    assert_eq!(pages[0]["commits"][1], same(&page.commits[1]));
}

#[test]
fn diff_streams_the_change_set_of_a_commit_and_of_the_working_tree() {
    let f = Fixture::new();
    let e = f.engine();
    let never = Cancel::never();
    let (status, out, err) = cli(&["diff", f.path(), "--commit", "topic"]);
    assert_eq!((status, err.as_str()), (0, ""));
    let pages = lines(&out);
    assert_eq!(pages.len(), 2);
    assert_eq!(pages[0]["kind"], "page");
    assert_eq!(pages[0]["files"][0]["path"], "src/lib.rs");
    let whole = e
        .diff(
            &DiffTarget::Commit {
                hash: "topic".to_owned(),
            },
            &DiffOptions::default(),
            &never,
        )
        .expect("diff");
    assert_eq!(pages[0]["files"], same(&whole.files));
    assert_eq!(pages[1]["kind"], "done");
    let (_, out, _) = cli(&["diff", f.path(), "--working-tree", "--base", "index"]);
    let pages = lines(&out);
    let paths: Vec<&str> = pages[0]["files"]
        .as_array()
        .expect("files")
        .iter()
        .filter_map(|file| file["path"].as_str())
        .collect();
    assert_eq!(paths, ["README.md", "new.txt"]);
    let whole = e
        .diff(
            &DiffTarget::WorkingTree {
                base: WorkingTreeBase::Index,
            },
            &DiffOptions::default(),
            &never,
        )
        .expect("diff");
    assert_eq!(pages[0]["files"], same(&whole.files));
    let (_, out, _) = cli(&["diff", f.path(), "--range", "main...topic"]);
    assert_eq!(lines(&out)[0]["files"][0]["path"], "src/lib.rs");
}

#[test]
fn failures_are_documents_on_stderr_with_status_one() {
    let f = Fixture::new();
    let (status, out, err) = cli(&["compare", f.path(), "main", "no-such-branch"]);
    assert_eq!(status, 1);
    assert!(out.is_empty());
    let failure = json(&err);
    assert_eq!(failure["code"], "refs.not_found");
    assert!(failure["message"]
        .as_str()
        .is_some_and(|m| m.contains("no-such-branch")));
    let (status, _, err) = cli(&["blob", f.path(), "missing.txt", "--rev", "main"]);
    assert_eq!(status, 1);
    assert!(json(&err)["code"].as_str().is_some());
    let nowhere = Path::new(f.path()).join("nowhere");
    let (status, _, err) = cli(&["refs", nowhere.to_str().expect("utf-8")]);
    assert_eq!(status, 1);
    assert_eq!(json(&err)["code"], "repo.not_found");
}
