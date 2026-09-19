//! Fixture repositories built with the git CLI in temporary directories.
//!
//! Every integration test file declares `mod support;` and builds the scenario it needs. The
//! git configuration is isolated from the machine (no system or global config) and commit
//! dates advance by one minute per commit from a fixed epoch, so orders and hashes are stable.

#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tempfile::TempDir;

/// 2024-01-01T00:00:00Z.
const BASE_TIME: i64 = 1_704_067_200;

/// A temporary repository plus the helpers to grow it.
pub struct Fixture {
    dir: TempDir,
    /// Working tree root of the main repository.
    pub root: PathBuf,
    clock: i64,
}

impl Fixture {
    /// `git init -b main` in `<tmp>/repo` with isolated configuration and no commits.
    pub fn empty() -> Self {
        Self::init_at("repo")
    }

    /// Like [`Fixture::empty`] but the repository folder has spaces and non-ASCII characters.
    pub fn with_odd_path() -> Self {
        Self::init_at("repo with spaces ünïcödé")
    }

    /// An unborn repository: `git init` and nothing else.
    pub fn unborn() -> Self {
        Self::empty()
    }

    fn init_at(folder: &str) -> Self {
        let dir = tempfile::Builder::new()
            .prefix("begira-fixture-")
            .tempdir()
            .expect("create temp dir");
        let root = dir.path().join(folder);
        fs::create_dir_all(&root).expect("create repo folder");
        let fixture = Self {
            dir,
            root,
            clock: BASE_TIME,
        };
        fixture.git(&["init", "-q", "-b", "main"]);
        fixture.git(&["config", "user.name", "Fixture"]);
        fixture.git(&["config", "user.email", "fixture@example.com"]);
        fixture.git(&["config", "commit.gpgsign", "false"]);
        fixture.git(&["config", "core.autocrlf", "false"]);
        fixture.git(&["config", "gc.auto", "0"]);
        fixture
    }

    /// Main line with a branch, a merge and an annotated tag:
    ///
    /// ```text
    /// c1 (README) - c2 (src/lib.rs, tag v1) - c3 (docs) - m1 (merge develop)   <- main, HEAD
    ///                \- d1 (src/dev.rs) - d2 -----------------/                 <- develop
    /// ```
    pub fn basic() -> Self {
        let mut f = Self::empty();
        f.write("README.md", "# Fixture\n");
        f.commit("c1: add readme");
        f.write("src/lib.rs", "pub fn one() -> u32 {\n    1\n}\n");
        f.commit("c2: add lib");
        f.git(&["tag", "-a", "v1", "-m", "version 1"]);
        f.git(&["checkout", "-q", "-b", "develop"]);
        f.write("src/dev.rs", "pub fn dev() {}\n");
        f.commit("d1: start develop");
        f.append("src/dev.rs", "pub fn more() {}\n");
        f.commit("d2: more develop\n\nSecond paragraph of the body.\n");
        f.git(&["checkout", "-q", "main"]);
        f.write("docs/guide.md", "guide\n");
        f.commit("c3: docs");
        f.tick();
        f.git(&[
            "merge",
            "-q",
            "--no-ff",
            "-m",
            "m1: merge develop",
            "develop",
        ]);
        f
    }

    /// Adds a bare remote `origin` with `main` and `develop` pushed and tracked, then leaves
    /// `develop` 2 commits ahead of and 3 commits behind `origin/develop`. HEAD stays on `main`.
    pub fn with_remote(mut self) -> Self {
        let origin = self.sibling("origin.git");
        let origin = origin.to_str().expect("utf-8 temp path");
        self.git(&["init", "-q", "--bare", origin]);
        self.git(&["remote", "add", "origin", origin]);
        self.git(&["push", "-q", "-u", "origin", "main", "develop"]);
        self.git(&["checkout", "-q", "develop"]);
        for i in 1..=3 {
            self.write(&format!("remote-{i}.txt"), "remote\n");
            self.commit(&format!("r{i}: remote only"));
        }
        self.git(&["push", "-q", "origin", "develop"]);
        self.git(&["reset", "-q", "--hard", "HEAD~3"]);
        for i in 1..=2 {
            self.write(&format!("local-{i}.txt"), "local\n");
            self.commit(&format!("l{i}: local only"));
        }
        self.git(&["checkout", "-q", "main"]);
        self
    }

    /// Three branches from `main` merged into `main` by one octopus commit.
    pub fn with_octopus(mut self) -> Self {
        for name in ["oct-a", "oct-b", "oct-c"] {
            self.git(&["checkout", "-q", "-b", name, "main"]);
            self.write(&format!("{name}.txt"), "octopus\n");
            self.commit(&format!("{name}: feature"));
        }
        self.git(&["checkout", "-q", "main"]);
        self.tick();
        self.git(&[
            "merge",
            "-q",
            "--no-ff",
            "-m",
            "octopus: merge three branches",
            "oct-a",
            "oct-b",
            "oct-c",
        ]);
        self
    }

    /// Grows `src/lib.rs` to twenty lines, then renames it to `src/core.rs` changing two of
    /// them (10%), in two commits on `main`.
    pub fn with_rename(mut self) -> Self {
        let lines: Vec<String> = (1..=20)
            .map(|i| format!("pub fn f{i}() -> u32 {{ {i} }}"))
            .collect();
        self.write("src/lib.rs", &(lines.join("\n") + "\n"));
        self.commit("grow lib");
        let mut renamed = lines;
        renamed[4] = "pub fn f5() -> u32 { 50 }".to_owned();
        renamed[9] = "pub fn f10() -> u32 { 100 }".to_owned();
        self.remove("src/lib.rs");
        self.write("src/core.rs", &(renamed.join("\n") + "\n"));
        self.commit("rename lib to core");
        self
    }

    /// Leaves one stash entry, "wip: stash", holding a modified `README.md`.
    pub fn with_stash(mut self) -> Self {
        self.append("README.md", "stashed line\n");
        self.tick();
        self.git(&["stash", "push", "-q", "-m", "wip: stash"]);
        self
    }

    /// Adds a linked worktree at [`Fixture::worktree_path`] on the new branch `feature/wt`.
    pub fn with_linked_worktree(mut self) -> Self {
        let path = self.worktree_path();
        let path = path.to_str().expect("utf-8 temp path");
        self.tick();
        self.git(&["worktree", "add", "-q", "-b", "feature/wt", path]);
        self
    }

    /// Path of the linked worktree created by [`Fixture::with_linked_worktree`].
    pub fn worktree_path(&self) -> PathBuf {
        self.sibling("wt-feature")
    }

    /// Adds two more linked worktrees: `wt-gone` on branch `gone`, whose folder is deleted
    /// afterwards (prunable), and `wt-locked` on branch `locked`, locked with reason "testing".
    pub fn with_broken_worktrees(mut self) -> Self {
        let gone = self.sibling("wt-gone");
        let locked = self.sibling("wt-locked");
        self.tick();
        self.git(&[
            "worktree",
            "add",
            "-q",
            "-b",
            "gone",
            gone.to_str().expect("utf-8 temp path"),
        ]);
        self.git(&[
            "worktree",
            "add",
            "-q",
            "-b",
            "locked",
            locked.to_str().expect("utf-8 temp path"),
        ]);
        self.git(&[
            "worktree",
            "lock",
            "--reason",
            "testing",
            locked.to_str().expect("utf-8 temp path"),
        ]);
        fs::remove_dir_all(&gone).expect("remove worktree folder");
        self
    }

    /// Commits a `.gitignore`, then leaves a staged new file (`staged.txt`), a modified
    /// unstaged file (`README.md`), an untracked file (`untracked.txt`) and an ignored file
    /// (`ignored.log`).
    pub fn with_mixed_status(mut self) -> Self {
        self.write(".gitignore", "ignored.log\n");
        self.commit("add gitignore");
        self.write("staged.txt", "staged\n");
        self.git(&["add", "staged.txt"]);
        self.append("README.md", "modified\n");
        self.write("untracked.txt", "untracked\n");
        self.write("ignored.log", "ignored\n");
        self
    }

    /// Overwrites the loose object of `spec` with garbage so reading it fails; returns its hash.
    pub fn truncate_object(&self, spec: &str) -> String {
        let hash = self.rev(spec);
        let path = self
            .git_dir()
            .join("objects")
            .join(&hash[..2])
            .join(&hash[2..]);
        let mut permissions = fs::metadata(&path).expect("object exists").permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        fs::set_permissions(&path, permissions).expect("make object writable");
        fs::write(&path, b"x").expect("truncate object");
        hash
    }

    /// The `.git` directory of the main repository.
    pub fn git_dir(&self) -> PathBuf {
        self.root.join(".git")
    }

    /// A path inside the temp dir but outside the repository, for worktrees and remotes.
    pub fn sibling(&self, name: &str) -> PathBuf {
        self.dir.path().join(name)
    }

    /// Advances the commit clock by one minute.
    pub fn tick(&mut self) {
        self.clock += 60;
    }

    /// Current clock as a Unix timestamp.
    pub fn now(&self) -> i64 {
        self.clock
    }

    /// Stages everything and commits with the next clock tick; returns the new HEAD hash.
    pub fn commit(&mut self, message: &str) -> String {
        self.tick();
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", message]);
        self.head()
    }

    /// Writes a file under the root, creating parent folders.
    pub fn write(&self, relative: &str, content: &str) {
        let path = self.root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent folders");
        }
        fs::write(path, content).expect("write file");
    }

    /// Appends to a file under the root.
    pub fn append(&self, relative: &str, content: &str) {
        let path = self.root.join(relative);
        let mut existing = fs::read_to_string(&path).unwrap_or_default();
        existing.push_str(content);
        fs::write(path, existing).expect("append to file");
    }

    /// Removes a file under the root.
    pub fn remove(&self, relative: &str) {
        fs::remove_file(self.root.join(relative)).expect("remove file");
    }

    /// `git rev-parse HEAD`.
    pub fn head(&self) -> String {
        self.rev("HEAD")
    }

    /// `git rev-parse --verify <spec>`.
    pub fn rev(&self, spec: &str) -> String {
        self.git(&["rev-parse", "--verify", spec])
    }

    /// Runs `git` in the root and returns trimmed stdout; panics with stderr on failure.
    pub fn git(&self, args: &[&str]) -> String {
        self.git_in(&self.root.clone(), args)
    }

    /// Runs `git` in `cwd` and returns trimmed stdout; panics with stderr on failure.
    pub fn git_in(&self, cwd: &Path, args: &[&str]) -> String {
        let (ok, stdout, stderr) = self.try_git_in(cwd, args);
        assert!(ok, "git {args:?} failed in {}:\n{stderr}", cwd.display());
        stdout
    }

    /// Runs `git` in the root without panicking: `(success, stdout, stderr)`.
    pub fn try_git(&self, args: &[&str]) -> (bool, String, String) {
        self.try_git_in(&self.root.clone(), args)
    }

    /// Runs `git` in `cwd` without panicking: `(success, stdout, stderr)`.
    pub fn try_git_in(&self, cwd: &Path, args: &[&str]) -> (bool, String, String) {
        let output = self
            .command(cwd)
            .args(args)
            .output()
            .unwrap_or_else(|error| panic!("cannot run git {args:?}: {error}"));
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout)
                .trim_end()
                .to_owned(),
            String::from_utf8_lossy(&output.stderr)
                .trim_end()
                .to_owned(),
        )
    }

    fn command(&self, cwd: &Path) -> Command {
        let date = format!("{} +0000", self.clock);
        let mut command = Command::new("git");
        command
            .current_dir(cwd)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env(
                "GIT_CONFIG_GLOBAL",
                self.dir.path().join("no-global-config"),
            )
            .env("GIT_AUTHOR_NAME", "Fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.com")
            .env("GIT_COMMITTER_NAME", "Fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.com")
            .env("GIT_AUTHOR_DATE", &date)
            .env("GIT_COMMITTER_DATE", &date)
            .env("LC_ALL", "C")
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE");
        command
    }

    /// Sets the commit clock to `unix` seconds; the next commit gets `unix + 60`. Moving it
    /// backwards creates a commit older than its parent (date skew).
    pub fn set_clock(&mut self, unix: i64) {
        self.clock = unix;
    }
}

/// Canonical form of a path for comparisons (resolves symlinks and, on Windows, the `\\?\`
/// prefix appears on both sides).
pub fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path)
        .unwrap_or_else(|error| panic!("canonicalize {}: {error}", path.display()))
}
