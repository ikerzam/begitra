//! `bench generate`: a deterministic synthetic "agent" repository.
//!
//! The repository imitates a codebase written mostly by coding agents: an initial import of
//! tens of thousands of files in deep directory trees (source, tests, generated code marked
//! `linguist-generated`, lockfiles, binary assets, a few very large files), then a long history
//! of small commits on `main` and on hundreds of short-lived branches, most merged back with a
//! merge commit, some left open; annotated tags every so often; remote-tracking refs behind
//! the local branches; one stash; and linked worktrees on open branches.
//!
//! Everything derives from `--seed`: the same seed on the same generator version produces the
//! same HEAD hash on any platform (contents, dates and authors are all generated, never read
//! from the environment).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use git2::{Oid, Repository, Signature, Time, Tree};
use git_core::cli::run_git;

use crate::{Error, Result};

/// Generator settings.
#[derive(Clone, Debug)]
pub struct Config {
    /// Where the repository is created.
    pub out: PathBuf,
    /// Folder that receives the linked worktrees (one subfolder each).
    pub worktrees_dir: PathBuf,
    /// Commits to create after the initial import.
    pub commits: u32,
    /// Branches to create over the history.
    pub branches: u32,
    /// Linked worktrees to add at the end, on open branches.
    pub worktrees: u32,
    /// Files in the initial import.
    pub files: u32,
    /// Seed of the pseudo-random generator.
    pub seed: u64,
    /// Regenerate even when the repository exists.
    pub force: bool,
    /// Run `git gc` at the end so objects are packed like in a real repository.
    pub gc: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            out: crate::repos::synthetic(),
            worktrees_dir: crate::repos::synthetic_worktrees(),
            commits: 100_000,
            branches: 200,
            worktrees: 20,
            files: 50_000,
            seed: 42,
            force: false,
            gc: true,
        }
    }
}

/// What was generated.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    /// The repository already existed and `--force` was not given.
    pub skipped: bool,
    /// HEAD of `main`.
    pub head: String,
    /// Commits reachable from any ref (`git rev-list --count --all`).
    pub commits: u32,
    /// Merge commits among them.
    pub merges: u32,
    /// Local branches, `main` included.
    pub branches: u32,
    /// Annotated tags.
    pub tags: u32,
    /// Linked worktrees.
    pub worktrees: u32,
    /// Files in the final tree of `main`.
    pub files: u32,
    /// Files of 5,000 lines or more.
    pub large_files: u32,
    /// Binary files.
    pub binary_files: u32,
    /// Files marked `linguist-generated` (plus lockfiles).
    pub generated_files: u32,
    /// Deepest directory nesting in the tree.
    pub max_depth: u32,
    /// Wall-clock time of the generation.
    pub elapsed: Duration,
}

impl std::fmt::Display for Summary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.skipped {
            writeln!(
                f,
                "repository exists (HEAD {}); pass --force to regenerate",
                self.head
            )?;
            return Ok(());
        }
        writeln!(f, "HEAD           {}", self.head)?;
        writeln!(
            f,
            "commits        {} ({} merges)",
            self.commits, self.merges
        )?;
        writeln!(f, "branches       {}", self.branches)?;
        writeln!(f, "tags           {}", self.tags)?;
        writeln!(f, "worktrees      {}", self.worktrees)?;
        writeln!(
            f,
            "files          {} ({} large, {} binary, {} generated, depth {})",
            self.files, self.large_files, self.binary_files, self.generated_files, self.max_depth
        )?;
        writeln!(f, "elapsed        {:.1} s", self.elapsed.as_secs_f64())
    }
}

/// xorshift64*: small, fast and deterministic across platforms.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next() % n
        }
    }

    fn between(&mut self, low: u64, high_inclusive: u64) -> u64 {
        low + self.below(high_inclusive.saturating_sub(low) + 1)
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        let index = self.below(items.len() as u64) as usize;
        &items[index]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lang {
    Rust,
    Ts,
    Py,
    Go,
}

impl Lang {
    const ALL: [Lang; 4] = [Lang::Rust, Lang::Ts, Lang::Py, Lang::Go];

    fn ext(self) -> &'static str {
        match self {
            Lang::Rust => "rs",
            Lang::Ts => "ts",
            Lang::Py => "py",
            Lang::Go => "go",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Source(Lang),
    Test(Lang),
    Large(Lang),
    Generated,
    Lockfile,
    Binary,
}

/// A file of the repository and its current version.
#[derive(Clone, Debug)]
struct FileInfo {
    path: String,
    kind: Kind,
    seed: u64,
    lines: u32,
    version: u32,
}

const WORDS: [&str; 40] = [
    "core", "api", "ui", "auth", "billing", "graph", "diff", "utils", "models", "handlers",
    "internal", "v2", "sync", "cache", "search", "index", "worker", "queue", "events", "config",
    "storage", "net", "proto", "schema", "review", "agents", "tools", "runtime", "session",
    "policy", "audit", "metrics", "layout", "render", "parser", "lexer", "compiler", "planner",
    "ledger", "vault",
];

const AUTHORS: [(&str, &str); 8] = [
    ("Claude Code", "claude@agents.local"),
    ("Codex", "codex@agents.local"),
    ("Cursor Agent", "cursor@agents.local"),
    ("Devin", "devin@agents.local"),
    ("Copilot Workspace", "copilot@agents.local"),
    ("Iker Zamora", "iker@example.com"),
    ("Ane Etxeberria", "ane@example.com"),
    ("Jon Urrutia", "jon@example.com"),
];

const SUBJECTS: [&str; 24] = [
    "feat: add {w} {x} endpoint",
    "feat({w}): wire {x} into the {w} pipeline",
    "fix({w}): handle empty {x} responses",
    "fix: guard against nil {x} in {w}",
    "refactor({w}): extract {x} helper",
    "refactor: split {w} {x} module",
    "test({w}): cover {x} edge cases",
    "test: add regression test for {x}",
    "docs({w}): describe the {x} flow",
    "chore({w}): bump {x} dependencies",
    "perf({w}): cache {x} lookups",
    "feat({w}): implement {x} retries with backoff",
    "fix({w}): correct {x} pagination cursor",
    "refactor({w}): rename {x} to match the spec",
    "chore: regenerate {x} client",
    "feat: {x} support for {w}",
    "fix: {x} race in {w} worker",
    "style({w}): format {x}",
    "feat({w}): validate {x} input",
    "fix({w}): {x} timezone handling",
    "test({w}): property test for {x}",
    "feat({w}): stream {x} results",
    "fix: flaky {x} test in {w}",
    "chore({w}): remove dead {x} code",
];

const BODIES: [&str; 6] = [
    "Generated by the agent from the task description. Reviewed the diff before committing.",
    "The previous implementation assumed the list was never empty.\n\nAdded a test that reproduces the report.",
    "Part of the {w} migration tracked in the roadmap.",
    "Keeps the public API unchanged; only internal call sites move.",
    "Benchmarked locally: no measurable change in the hot path.",
    "Follow-up to the review comments on the {x} change.",
];

/// Generates the repository described by `config`.
pub fn run(config: &Config) -> Result<Summary> {
    let started = Instant::now();
    if config.out.exists() {
        if !config.force {
            let head = run_git(&config.out, &["rev-parse", "HEAD"])
                .map(|out| out.stdout.trim().to_owned())
                .unwrap_or_else(|_| "unknown".to_owned());
            return Ok(Summary {
                skipped: true,
                head,
                commits: 0,
                merges: 0,
                branches: 0,
                tags: 0,
                worktrees: 0,
                files: 0,
                large_files: 0,
                binary_files: 0,
                generated_files: 0,
                max_depth: 0,
                elapsed: started.elapsed(),
            });
        }
        remove_generated(&config.out, &config.worktrees_dir)?;
    }
    if config.worktrees_dir.exists() {
        std::fs::remove_dir_all(&config.worktrees_dir)
            .map_err(|source| Error::io("remove old worktrees", source))?;
    }
    std::fs::create_dir_all(&config.out)
        .map_err(|source| Error::io(format!("create {}", config.out.display()), source))?;

    let mut opts = git2::RepositoryInitOptions::new();
    opts.initial_head("main");
    let repo = Repository::init_opts(&config.out, &opts)?;
    {
        let mut cfg = repo.config()?;
        cfg.set_str("user.name", "Bench")?;
        cfg.set_str("user.email", "bench@example.com")?;
        cfg.set_bool("core.autocrlf", false)?;
        cfg.set_bool("commit.gpgsign", false)?;
        cfg.set_i32("gc.auto", 0)?;
        cfg.set_str(
            "remote.origin.url",
            "https://example.invalid/agent-repo.git",
        )?;
        cfg.set_str("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")?;
        cfg.set_str("branch.main.remote", "origin")?;
        cfg.set_str("branch.main.merge", "refs/heads/main")?;
    }

    let mut rng = Rng::new(config.seed);
    let mut clock: i64 = 1_704_067_200; // 2024-01-01T00:00:00Z
    let mut files = initial_files(&mut rng, config.files);
    let mut counter = files.len() as u64;

    eprintln!("bench generate: importing {} files", files.len());
    let initial_tree = import_tree(&repo, &files)?;
    let sig = author(&mut rng, clock);
    let initial = repo.commit(
        Some("refs/heads/main"),
        &sig,
        &sig,
        "chore: initial import of the agent workspace",
        &repo.find_tree(initial_tree)?,
        &[],
    )?;

    let mut main_tip = initial;
    let mut main_tree = initial_tree;
    let mut main_history = vec![initial];
    let mut open: Vec<Branch> = Vec::new();
    let mut created_branches = 0u32;
    let mut merges = 0u32;
    let mut tags = 0u32;
    let mut branch_names: Vec<String> = Vec::new();
    let branch_every = (config.commits / config.branches.max(1)).max(1);
    let tag_every = (config.commits / 20).max(1);

    for i in 0..config.commits {
        if i.is_multiple_of(10_000) && i > 0 {
            eprintln!("bench generate: {i} commits");
        }
        clock += rng.between(30, 900) as i64;
        if created_branches < config.branches && i.is_multiple_of(branch_every) {
            let name = branch_name(&mut rng, created_branches);
            repo.reference(&format!("refs/heads/{name}"), main_tip, true, "branch")?;
            branch_names.push(name.clone());
            open.push(Branch {
                name,
                tip: main_tip,
                tree: main_tree,
                touched: BTreeMap::new(),
                remaining: rng.between(
                    3,
                    (config.commits / config.branches.max(1) / 2).clamp(3, 30) as u64,
                ) as u32,
            });
            created_branches += 1;
        }

        let on_side = !open.is_empty() && rng.chance(45);
        let changes = make_changes(&repo, &mut rng, &mut files, &mut counter)?;
        let (subject, body) = message(&mut rng);
        let sig = author(&mut rng, clock);
        let full_message = match body {
            Some(body) => format!("{subject}\n\n{body}\n"),
            None => format!("{subject}\n"),
        };

        if on_side {
            let index = rng.below(open.len() as u64) as usize;
            let branch = &mut open[index];
            let new_tree = apply(&repo, Some(branch.tree), &changes)?;
            let parent = repo.find_commit(branch.tip)?;
            let commit = repo.commit(
                Some(&format!("refs/heads/{}", branch.name)),
                &sig,
                &sig,
                &full_message,
                &repo.find_tree(new_tree)?,
                &[&parent],
            )?;
            branch.tip = commit;
            branch.tree = new_tree;
            branch.touched.extend(changes);
            branch.remaining -= 1;
            if branch.remaining == 0 {
                let finished = open.remove(index);
                if rng.chance(65) {
                    clock += rng.between(30, 300) as i64;
                    let merged_tree = apply(&repo, Some(main_tree), &finished.touched)?;
                    let merger = author(&mut rng, clock);
                    let ours = repo.find_commit(main_tip)?;
                    let theirs = repo.find_commit(finished.tip)?;
                    let merge = repo.commit(
                        Some("refs/heads/main"),
                        &merger,
                        &merger,
                        &format!("Merge branch '{}'\n", finished.name),
                        &repo.find_tree(merged_tree)?,
                        &[&ours, &theirs],
                    )?;
                    main_tip = merge;
                    main_tree = merged_tree;
                    main_history.push(merge);
                    merges += 1;
                }
            }
        } else {
            let new_tree = apply(&repo, Some(main_tree), &changes)?;
            let parent = repo.find_commit(main_tip)?;
            let commit = repo.commit(
                Some("refs/heads/main"),
                &sig,
                &sig,
                &full_message,
                &repo.find_tree(new_tree)?,
                &[&parent],
            )?;
            main_tip = commit;
            main_tree = new_tree;
            main_history.push(commit);
            if i.is_multiple_of(tag_every) && i > 0 {
                tags += 1;
                let object = repo.find_object(commit, None)?;
                repo.tag(
                    &format!("v0.{tags}.0"),
                    &object,
                    &sig,
                    &format!("Release 0.{tags}.0\n"),
                    false,
                )?;
            }
        }
    }

    // Remote-tracking refs behind the local branches, so ahead/behind counts are non-trivial.
    let behind = rng.between(20, 200) as usize;
    let origin_main = main_history[main_history.len().saturating_sub(1 + behind)];
    repo.reference("refs/remotes/origin/main", origin_main, true, "remote")?;
    for name in branch_names.iter().take(branch_names.len() / 2) {
        let tip = repo
            .find_reference(&format!("refs/heads/{name}"))?
            .target()
            .ok_or_else(|| Error::Usage(format!("branch {name} has no target")))?;
        let mut commit = repo.find_commit(tip)?;
        for _ in 0..rng.between(0, 3) {
            match commit.parent(0) {
                Ok(parent) => commit = parent,
                Err(_) => break,
            }
        }
        repo.reference(
            &format!("refs/remotes/origin/{name}"),
            commit.id(),
            true,
            "remote",
        )?;
        let mut cfg = repo.config()?;
        cfg.set_str(&format!("branch.{name}.remote"), "origin")?;
        cfg.set_str(
            &format!("branch.{name}.merge"),
            &format!("refs/heads/{name}"),
        )?;
    }

    eprintln!("bench generate: checking out {} files", files.len());
    repo.set_head("refs/heads/main")?;
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force()))?;

    // One stash, made the way a user would.
    if let Some(file) = files.iter().find(|f| matches!(f.kind, Kind::Source(_))) {
        let path = config.out.join(&file.path);
        let mut content = std::fs::read_to_string(&path).unwrap_or_default();
        content.push_str("// scratch line left by an agent\n");
        std::fs::write(&path, content).map_err(|source| Error::io("write stash change", source))?;
        run_git(
            &config.out,
            &["stash", "push", "-q", "-m", "wip: agent scratch"],
        )?;
    }

    // Linked worktrees on open branches (or on fresh branches when none is left open).
    let mut worktrees = 0u32;
    if config.worktrees > 0 {
        std::fs::create_dir_all(&config.worktrees_dir)
            .map_err(|source| Error::io("create worktrees folder", source))?;
        let mut candidates: Vec<String> = open.iter().map(|b| b.name.clone()).collect();
        let mut extra = 0;
        while (candidates.len() as u32) < config.worktrees {
            let name = format!("agent/extra-worktree-{extra}");
            repo.reference(&format!("refs/heads/{name}"), main_tip, true, "branch")?;
            candidates.push(name);
            extra += 1;
        }
        for (n, branch) in candidates
            .iter()
            .take(config.worktrees as usize)
            .enumerate()
        {
            let path = config.worktrees_dir.join(format!("wt-{:02}", n + 1));
            let path = path
                .to_str()
                .ok_or_else(|| Error::Usage("worktree path must be UTF-8".to_owned()))?;
            eprintln!("bench generate: worktree {} on {branch}", n + 1);
            run_git(&config.out, &["worktree", "add", "-q", path, branch])?;
            worktrees += 1;
        }
    }

    if config.gc {
        eprintln!("bench generate: packing objects (git gc)");
        run_git(&config.out, &["gc", "-q"])?;
    }

    let commits: u32 = run_git(&config.out, &["rev-list", "--count", "--all"])?
        .stdout
        .trim()
        .parse()
        .map_err(|_| Error::Report("rev-list count".to_owned()))?;
    let branches = repo
        .branches(Some(git2::BranchType::Local))?
        .count()
        .try_into()
        .unwrap_or(u32::MAX);
    let mut max_depth = 0;
    let mut large_files = 0;
    let mut binary_files = 0;
    let mut generated_files = 0;
    for file in &files {
        max_depth = max_depth.max(file.path.matches('/').count() as u32);
        match file.kind {
            Kind::Large(_) => large_files += 1,
            Kind::Binary => binary_files += 1,
            Kind::Generated | Kind::Lockfile => generated_files += 1,
            _ => {}
        }
    }
    Ok(Summary {
        skipped: false,
        head: main_tip.to_string(),
        commits,
        merges,
        branches,
        tags,
        worktrees,
        files: files.len() as u32,
        large_files,
        binary_files,
        generated_files,
        max_depth,
        elapsed: started.elapsed(),
    })
}

/// A branch with commits in progress.
struct Branch {
    name: String,
    tip: Oid,
    tree: Oid,
    touched: BTreeMap<String, Option<Oid>>,
    remaining: u32,
}

fn remove_generated(out: &Path, worktrees_dir: &Path) -> Result<()> {
    if worktrees_dir.exists() {
        std::fs::remove_dir_all(worktrees_dir)
            .map_err(|source| Error::io("remove old worktrees", source))?;
    }
    // Packed objects are read-only on Windows; clear the bit before removing.
    make_writable(out)?;
    std::fs::remove_dir_all(out)
        .map_err(|source| Error::io(format!("remove {}", out.display()), source))
}

fn make_writable(dir: &Path) -> Result<()> {
    for entry in std::fs::read_dir(dir).map_err(|source| Error::io("read dir", source))? {
        let entry = entry.map_err(|source| Error::io("read dir entry", source))?;
        let path = entry.path();
        let metadata =
            std::fs::symlink_metadata(&path).map_err(|source| Error::io("stat", source))?;
        if metadata.is_dir() {
            make_writable(&path)?;
        } else if metadata.permissions().readonly() {
            let mut permissions = metadata.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            std::fs::set_permissions(&path, permissions)
                .map_err(|source| Error::io("chmod", source))?;
        }
    }
    Ok(())
}

fn author(rng: &mut Rng, clock: i64) -> Signature<'static> {
    // Agents write most of the history.
    let index = if rng.chance(70) {
        rng.below(5) as usize
    } else {
        5 + rng.below(3) as usize
    };
    let (name, email) = AUTHORS[index];
    Signature::new(name, email, &Time::new(clock, 60)).unwrap_or_else(|_| {
        // Static ASCII names never fail; keep the generator infallible here.
        Signature::new("Bench", "bench@example.com", &Time::new(clock, 60))
            .expect("static signature")
    })
}

fn message(rng: &mut Rng) -> (String, Option<String>) {
    let w = *rng.pick(&WORDS);
    let x = *rng.pick(&WORDS);
    let subject = rng.pick(&SUBJECTS).replace("{w}", w).replace("{x}", x);
    let body = rng
        .chance(25)
        .then(|| rng.pick(&BODIES).replace("{w}", w).replace("{x}", x));
    (subject, body)
}

fn branch_name(rng: &mut Rng, n: u32) -> String {
    let prefix = *rng.pick(&["claude", "codex", "cursor", "feature", "fix", "agent"]);
    let w = *rng.pick(&WORDS);
    let x = *rng.pick(&WORDS);
    format!("{prefix}/{w}-{x}-{n}")
}

fn random_dir(rng: &mut Rng, top: &str, deep: bool) -> String {
    let depth = if deep {
        rng.between(7, 9)
    } else {
        rng.between(0, 5)
    };
    let mut parts = vec![top.to_owned()];
    for _ in 0..depth {
        parts.push((*rng.pick(&WORDS)).to_owned());
    }
    parts.join("/")
}

fn new_file(rng: &mut Rng, counter: &mut u64, kind: Kind) -> FileInfo {
    *counter += 1;
    let n = *counter;
    let word = *rng.pick(&WORDS);
    let deep = rng.chance(2);
    let (path, lines) = match kind {
        Kind::Source(lang) => (
            format!(
                "{}/{word}_{n}.{}",
                {
                    let top = *rng.pick(&["src", "apps", "packages", "services"]);
                    random_dir(rng, top, deep)
                },
                lang.ext()
            ),
            rng.between(10, 80) as u32,
        ),
        Kind::Test(lang) => {
            let dir = random_dir(rng, "tests", deep);
            let name = match lang {
                Lang::Rust => format!("{word}_{n}_test.rs"),
                Lang::Ts => format!("{word}_{n}.test.ts"),
                Lang::Py => format!("test_{word}_{n}.py"),
                Lang::Go => format!("{word}_{n}_test.go"),
            };
            (format!("{dir}/{name}"), rng.between(20, 120) as u32)
        }
        Kind::Large(lang) => (
            format!(
                "{}/{word}_{n}_all.{}",
                random_dir(rng, "src", false),
                lang.ext()
            ),
            rng.between(5_000, 10_000) as u32,
        ),
        Kind::Generated => (
            format!("{}/{word}_{n}.ts", random_dir(rng, "gen", false)),
            rng.between(200, 2_000) as u32,
        ),
        Kind::Lockfile => (
            format!(
                "{}/{}",
                random_dir(rng, "packages", false),
                rng.pick(&["pnpm-lock.yaml", "Cargo.lock", "package-lock.json"])
            ),
            rng.between(500, 3_000) as u32,
        ),
        Kind::Binary => (
            format!(
                "{}/{word}_{n}.{}",
                random_dir(rng, "assets", false),
                rng.pick(&["png", "bin", "wasm"])
            ),
            rng.between(50, 500) as u32, // KiB
        ),
    };
    FileInfo {
        path,
        kind,
        seed: rng.next(),
        lines,
        version: 0,
    }
}

fn initial_files(rng: &mut Rng, count: u32) -> Vec<FileInfo> {
    let mut counter = 0u64;
    let mut files = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let roll = rng.below(1000);
        let kind = if roll < 850 {
            Kind::Source(*rng.pick(&Lang::ALL))
        } else if roll < 950 {
            Kind::Test(*rng.pick(&Lang::ALL))
        } else if roll < 975 {
            Kind::Generated
        } else if roll < 985 {
            Kind::Large(*rng.pick(&Lang::ALL))
        } else if roll < 995 {
            Kind::Binary
        } else {
            Kind::Lockfile
        };
        files.push(new_file(rng, &mut counter, kind));
    }
    // Make sure the deep tree, the large files and the generated files always exist.
    files.push(new_file(rng, &mut counter, Kind::Large(Lang::Ts)));
    files.push(new_file(rng, &mut counter, Kind::Generated));
    files.push(new_file(rng, &mut counter, Kind::Binary));
    files.push(FileInfo {
        path: "src/a/b/c/d/e/f/g/h/deep.rs".to_owned(),
        kind: Kind::Source(Lang::Rust),
        seed: rng.next(),
        lines: 30,
        version: 0,
    });
    files.push(FileInfo {
        path: "pnpm-lock.yaml".to_owned(),
        kind: Kind::Lockfile,
        seed: rng.next(),
        lines: 2_500,
        version: 0,
    });
    files.push(FileInfo {
        path: ".gitattributes".to_owned(),
        kind: Kind::Generated,
        seed: 0,
        lines: 0,
        version: 0,
    });
    files
}

/// Deterministic content of a file at its current version.
fn content(file: &FileInfo) -> Vec<u8> {
    if file.path == ".gitattributes" {
        return b"gen/** linguist-generated=true\n*.pb.go linguist-generated=true\n*.lock linguist-generated=true\n".to_vec();
    }
    let mut rng = Rng::new(file.seed ^ 0xA5A5);
    match file.kind {
        Kind::Binary => {
            let size = file.lines as usize * 1024 + file.version as usize * 512;
            let mut bytes = Vec::with_capacity(size + 8);
            bytes.extend_from_slice(b"\x89PNG\r\n\x1a\n");
            while bytes.len() < size {
                bytes.extend_from_slice(&rng.next().to_le_bytes());
            }
            bytes
        }
        Kind::Source(lang) | Kind::Test(lang) | Kind::Large(lang) => source(lang, file, &mut rng),
        Kind::Generated => {
            let mut out =
                String::from("// Generated by openapi-typescript. Do not edit by hand.\n\n");
            let total = file.lines + file.version * 3;
            for i in 0..total {
                let w = WORDS[rng.below(WORDS.len() as u64) as usize];
                if i.is_multiple_of(4) {
                    out.push_str(&format!("export interface {w}{i} {{\n"));
                } else {
                    out.push_str(&format!("  {w}{i}: string;\n}}\n"));
                }
            }
            out.into_bytes()
        }
        Kind::Lockfile => {
            let mut out = String::from("lockfileVersion: '9.0'\n\npackages:\n");
            let total = file.lines + file.version * 5;
            for i in 0..total {
                let w = WORDS[rng.below(WORDS.len() as u64) as usize];
                out.push_str(&format!(
                    "  {w}-{i}@{}.{}.{}:\n    resolution: {{integrity: sha512-{:016x}}}\n",
                    rng.below(9),
                    rng.below(30),
                    rng.below(20),
                    rng.next()
                ));
            }
            out.into_bytes()
        }
    }
}

fn source(lang: Lang, file: &FileInfo, rng: &mut Rng) -> Vec<u8> {
    let total = file.lines + file.version * 2;
    let mut out = String::with_capacity(total as usize * 40);
    match lang {
        Lang::Rust => out.push_str(
            "//! Module generated for the benchmark corpus.\n\nuse std::collections::HashMap;\n\n",
        ),
        Lang::Ts => out.push_str(
            "// Module generated for the benchmark corpus.\nimport { z } from \"zod\";\n\n",
        ),
        Lang::Py => out
            .push_str("\"\"\"Module generated for the benchmark corpus.\"\"\"\n\nimport json\n\n"),
        Lang::Go => out.push_str(
            "// Package generated for the benchmark corpus.\npackage corpus\n\nimport \"fmt\"\n\n",
        ),
    }
    for i in 0..total {
        let w = WORDS[rng.below(WORDS.len() as u64) as usize];
        let v = rng.below(1000);
        // Every seventh line changes with the version, so edits are spread over the file.
        let stamp = if (i + file.version).is_multiple_of(7) && file.version > 0 {
            format!(" // v{}", file.version)
        } else {
            String::new()
        };
        let line = match lang {
            Lang::Rust => {
                format!("pub fn {w}_{i}(input: u32) -> u32 {{ input.wrapping_mul({v}) }}{stamp}\n")
            }
            Lang::Ts => {
                format!("export const {w}{i} = (input: number): number => input * {v};{stamp}\n")
            }
            Lang::Py => format!("def {w}_{i}(value):\n    return value * {v}{stamp}\n"),
            Lang::Go => format!(
                "func {}{i}(v int) int {{ return v * {v} }}{stamp}\n",
                capitalize(w)
            ),
        };
        out.push_str(&line);
    }
    out.into_bytes()
}

fn capitalize(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Writes every file as a blob and builds the initial tree through an in-memory index.
fn import_tree(repo: &Repository, files: &[FileInfo]) -> Result<Oid> {
    let mut index = git2::Index::new()?;
    for file in files {
        let blob = repo.blob(&content(file))?;
        let entry = git2::IndexEntry {
            ctime: git2::IndexTime::new(0, 0),
            mtime: git2::IndexTime::new(0, 0),
            dev: 0,
            ino: 0,
            mode: 0o100_644,
            uid: 0,
            gid: 0,
            file_size: 0,
            id: blob,
            flags: 0,
            flags_extended: 0,
            path: file.path.clone().into_bytes(),
        };
        index.add(&entry)?;
    }
    Ok(index.write_tree_to(repo)?)
}

/// Picks the files a commit touches and writes their new blobs.
fn make_changes(
    repo: &Repository,
    rng: &mut Rng,
    files: &mut Vec<FileInfo>,
    counter: &mut u64,
) -> Result<BTreeMap<String, Option<Oid>>> {
    let mut changes = BTreeMap::new();
    let count = match rng.below(100) {
        0..=39 => 1,
        40..=69 => 2,
        70..=84 => 3,
        85..=94 => 4,
        _ => 5,
    };
    for _ in 0..count {
        let roll = rng.below(100);
        if roll < 5 {
            let kind = if rng.chance(80) {
                Kind::Source(*rng.pick(&Lang::ALL))
            } else {
                Kind::Test(*rng.pick(&Lang::ALL))
            };
            let file = new_file(rng, counter, kind);
            let blob = repo.blob(&content(&file))?;
            changes.insert(file.path.clone(), Some(blob));
            files.push(file);
        } else if roll < 6 && files.len() > 10 {
            let index = rng.below(files.len() as u64) as usize;
            if matches!(files[index].kind, Kind::Source(_) | Kind::Test(_)) {
                let removed = files.swap_remove(index);
                changes.insert(removed.path, None);
            }
        } else {
            let wanted = if roll < 8 {
                |k: Kind| matches!(k, Kind::Large(_))
            } else if roll < 10 {
                |k: Kind| matches!(k, Kind::Generated | Kind::Lockfile)
            } else {
                |k: Kind| matches!(k, Kind::Source(_) | Kind::Test(_))
            };
            // A few random probes are enough: the wanted kinds are common.
            for _ in 0..16 {
                let index = rng.below(files.len() as u64) as usize;
                if wanted(files[index].kind) && files[index].path != ".gitattributes" {
                    let file = &mut files[index];
                    file.version += 1;
                    let blob = repo.blob(&content(file))?;
                    changes.insert(file.path.clone(), Some(blob));
                    break;
                }
            }
        }
    }
    Ok(changes)
}

/// Applies path changes (`Some(blob)` writes, `None` deletes) to `tree`, rewriting only the
/// trees along each changed path.
fn apply(
    repo: &Repository,
    tree: Option<Oid>,
    changes: &BTreeMap<String, Option<Oid>>,
) -> Result<Oid> {
    let mut files: BTreeMap<&str, Option<Oid>> = BTreeMap::new();
    let mut dirs: BTreeMap<&str, BTreeMap<String, Option<Oid>>> = BTreeMap::new();
    for (path, blob) in changes {
        match path.split_once('/') {
            Some((dir, rest)) => {
                dirs.entry(dir).or_default().insert(rest.to_owned(), *blob);
            }
            None => {
                files.insert(path.as_str(), *blob);
            }
        }
    }
    let existing: Option<Tree<'_>> = match tree {
        Some(oid) => Some(repo.find_tree(oid)?),
        None => None,
    };
    let mut builder = repo.treebuilder(existing.as_ref())?;
    for (name, blob) in files {
        match blob {
            Some(blob) => {
                builder.insert(name, blob, 0o100_644)?;
            }
            None => {
                if builder.get(name)?.is_some() {
                    builder.remove(name)?;
                }
            }
        }
    }
    for (name, subchanges) in dirs {
        let current = existing
            .as_ref()
            .and_then(|tree| tree.get_name(name))
            .filter(|entry| entry.kind() == Some(git2::ObjectType::Tree))
            .map(|entry| entry.id());
        let subtree = apply(repo, current, &subchanges)?;
        if repo.find_tree(subtree)?.is_empty() {
            if builder.get(name)?.is_some() {
                builder.remove(name)?;
            }
        } else {
            builder.insert(name, subtree, 0o040_000)?;
        }
    }
    Ok(builder.write()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn small(dir: &Path, seed: u64) -> Config {
        Config {
            out: dir.join("synthetic"),
            worktrees_dir: dir.join("synthetic-worktrees"),
            commits: 150,
            branches: 6,
            worktrees: 2,
            files: 120,
            seed,
            force: false,
            gc: false,
        }
    }

    #[test]
    fn same_seed_gives_the_same_head_and_counts() {
        let a = tempfile::tempdir().expect("temp");
        let b = tempfile::tempdir().expect("temp");
        let first = run(&small(a.path(), 42)).expect("generate a");
        let second = run(&small(b.path(), 42)).expect("generate b");
        assert!(!first.skipped);
        assert_eq!(first.head, second.head);
        assert_eq!(
            (first.commits, first.merges, first.branches, first.files),
            (second.commits, second.merges, second.branches, second.files)
        );
        assert!(first.commits > 150, "{first:?}");
        assert!(first.merges > 0, "{first:?}");
        assert_eq!(first.worktrees, 2);
        assert!(first.branches >= 7, "{first:?}");
        assert!(first.max_depth >= 8, "{first:?}");
        assert!(first.large_files >= 1 && first.binary_files >= 1 && first.generated_files >= 2);

        let other = tempfile::tempdir().expect("temp");
        let third = run(&small(other.path(), 7)).expect("generate c");
        assert_ne!(first.head, third.head);
    }

    #[test]
    fn skips_an_existing_repository_unless_forced() {
        let dir = tempfile::tempdir().expect("temp");
        let mut config = small(dir.path(), 42);
        config.worktrees = 0;
        let first = run(&config).expect("generate");
        let again = run(&config).expect("skip");
        assert!(again.skipped);
        assert_eq!(again.head, first.head);
        config.force = true;
        let forced = run(&config).expect("regenerate");
        assert!(!forced.skipped);
        assert_eq!(forced.head, first.head);
    }

    #[test]
    fn the_repository_is_valid_for_git() {
        let dir = tempfile::tempdir().expect("temp");
        let mut config = small(dir.path(), 3);
        config.worktrees = 1;
        let summary = run(&config).expect("generate");
        let out = run_git(
            &config.out,
            &["fsck", "--no-progress", "--connectivity-only"],
        );
        assert!(out.is_ok(), "{out:?}");
        let stash = run_git(&config.out, &["stash", "list"]).expect("stash list");
        assert!(stash.stdout.contains("wip: agent scratch"));
        let worktrees = run_git(&config.out, &["worktree", "list", "--porcelain"]).expect("wt");
        assert_eq!(worktrees.stdout.matches("worktree ").count(), 2);
        let attrs = run_git(
            &config.out,
            &["check-attr", "linguist-generated", "gen/x.ts"],
        )
        .expect("attr");
        assert!(attrs.stdout.contains("true"), "{}", attrs.stdout);
        let tags = run_git(&config.out, &["tag"]).expect("tags");
        assert_eq!(tags.stdout.lines().count() as u32, summary.tags);
    }
}
