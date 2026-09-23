//! Where the benchmark repositories live.

use std::path::{Path, PathBuf};

use crate::Error;

/// Clone URL of the large real repository.
pub const REAL_URL: &str = "https://github.com/torvalds/linux.git";

/// The folder holding every benchmark repository: `BEGITRA_BENCH_REPOS` when set, otherwise
/// `begitra-bench-repos` beside the repository root. Outside the project on purpose: inside
/// it, the dev server's dependency scanner and Tailwind's class scanner walked the kernel
/// clone and the synthetic tree (millions of files) at every start and the window stayed
/// blank for a minute.
pub fn repos_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("BEGITRA_BENCH_REPOS") {
        return PathBuf::from(dir);
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../begitra-bench-repos")
        .components()
        .collect()
}

/// The synthetic agent repository.
pub fn synthetic() -> PathBuf {
    repos_dir().join("synthetic")
}

/// Folder of the synthetic repository's linked worktrees.
pub fn synthetic_worktrees() -> PathBuf {
    repos_dir().join("synthetic-worktrees")
}

/// The large real repository.
pub fn real() -> PathBuf {
    repos_dir().join("real")
}

/// The folder tree of the discovery benchmark (`bench generate-tree`).
pub fn discovery() -> PathBuf {
    repos_dir().join("discovery")
}

/// Whether `path` is a git working tree with at least one commit.
pub fn is_repository(path: &Path) -> bool {
    git2::Repository::open(path)
        .ok()
        .and_then(|repo| repo.head().ok().and_then(|head| head.target()))
        .is_some()
}

/// Branch with one commit on top of HEAD that rewrites a large text file, created on demand
/// by [`ensure_large_file_branch`] for the large-file diff benchmark. The benchmark
/// repositories are the project's own fixtures (`begitra-bench-repos` beside the repository, or `BEGITRA_BENCH_REPOS`), so
/// the bench may add a ref to them; nothing points it at a user repository.
pub const LARGE_FILE_BRANCH: &str = "bench/large-file";

/// Makes sure [`LARGE_FILE_BRANCH`] exists and returns `(parent, commit)`: the commit changes
/// every third line of `file` (the largest text file of HEAD when `None`) without touching
/// the working tree or the index, through a temporary index and plumbing commands.
pub fn ensure_large_file_branch(
    path: &Path,
    file: Option<&str>,
) -> Result<(String, String), Error> {
    let full_ref = format!("refs/heads/{LARGE_FILE_BRANCH}");
    if let Ok(commit) = git(path, &["rev-parse", "--verify", "--quiet", &full_ref], &[]) {
        let parent = git(path, &["rev-parse", &format!("{commit}^")], &[])?;
        return Ok((parent, commit));
    }
    let file = match file {
        Some(file) => file.to_owned(),
        None => largest_text_file(path)?,
    };
    let head = git(path, &["rev-parse", "HEAD"], &[])?;
    // Raw blob bytes: `cat-file blob` applies no filters and the content is not trimmed, so
    // line endings and whitespace survive and only every third line changes.
    let content = git_bytes(path, &["cat-file", "blob", &format!("HEAD:{file}")])?;
    let mut rewritten = Vec::with_capacity(content.len() + content.len() / 3);
    for (index, line) in content.split_inclusive(|byte| *byte == b'\n').enumerate() {
        let (body, ending) = match line.strip_suffix(b"\r\n") {
            Some(body) => (body, &b"\r\n"[..]),
            None => match line.strip_suffix(b"\n") {
                Some(body) => (body, &b"\n"[..]),
                None => (line, &b""[..]),
            },
        };
        rewritten.extend_from_slice(body);
        if index % 3 == 0 {
            rewritten.extend_from_slice(b" // bench");
        }
        rewritten.extend_from_slice(ending);
    }
    let temp = TempDir::new()?;
    let blob_file = temp.path().join("blob");
    std::fs::write(&blob_file, rewritten).map_err(|source| Error::Io {
        context: format!("write {}", blob_file.display()),
        source,
    })?;
    let blob = git(
        path,
        &[
            "hash-object",
            "-w",
            "--no-filters",
            "--",
            &blob_file.to_string_lossy(),
        ],
        &[],
    )?;
    let index = temp.path().join("index");
    let index_env = [("GIT_INDEX_FILE", index.to_string_lossy().into_owned())];
    git(path, &["read-tree", "HEAD"], &index_env)?;
    git(
        path,
        &[
            "update-index",
            "--cacheinfo",
            &format!("100644,{blob},{file}"),
        ],
        &index_env,
    )?;
    let tree = git(path, &["write-tree"], &index_env)?;
    let identity = [
        ("GIT_AUTHOR_NAME", "bench".to_owned()),
        ("GIT_AUTHOR_EMAIL", "bench@begitra.local".to_owned()),
        ("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z".to_owned()),
        ("GIT_COMMITTER_NAME", "bench".to_owned()),
        ("GIT_COMMITTER_EMAIL", "bench@begitra.local".to_owned()),
        ("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z".to_owned()),
    ];
    let message = format!("bench: rewrite every third line of {file}");
    let commit = git(
        path,
        &["commit-tree", &tree, "-p", &head, "-m", &message],
        &identity,
    )?;
    git(path, &["update-ref", &full_ref, &commit], &[])?;
    Ok((head, commit))
}

/// A temporary folder removed on drop, also when a plumbing step fails.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Result<Self, Error> {
        let path = std::env::temp_dir().join(format!("begitra-bench-{}", std::process::id()));
        std::fs::create_dir_all(&path).map_err(|source| Error::Io {
            context: format!("create {}", path.display()),
            source,
        })?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The largest blob of HEAD with a source-like extension.
fn largest_text_file(path: &Path) -> Result<String, Error> {
    const TEXT: [&str; 12] = [
        ".rs", ".ts", ".tsx", ".js", ".py", ".go", ".c", ".h", ".md", ".json", ".yaml", ".txt",
    ];
    let listing = git(path, &["ls-tree", "-r", "-l", "HEAD"], &[])?;
    let mut best: Option<(u64, String)> = None;
    for line in listing.lines() {
        // `<mode> <type> <oid> <size>\t<path>`
        let Some((meta, file)) = line.split_once('\t') else {
            continue;
        };
        let size: u64 = meta
            .split_whitespace()
            .nth(3)
            .and_then(|size| size.parse().ok())
            .unwrap_or(0);
        if !TEXT.iter().any(|ext| file.ends_with(ext)) {
            continue;
        }
        if best.as_ref().is_none_or(|(largest, _)| size > *largest) {
            best = Some((size, file.to_owned()));
        }
    }
    best.map(|(_, file)| file).ok_or_else(|| Error::Io {
        context: format!("find a large text file in {}", path.display()),
        source: std::io::Error::new(std::io::ErrorKind::NotFound, "no text file"),
    })
}

/// Runs git with `args` in `path` and extra environment variables, returning trimmed stdout.
fn git(path: &Path, args: &[&str], env: &[(&str, String)]) -> Result<String, Error> {
    let output = git_bytes_with_env(path, args, env)?;
    Ok(String::from_utf8_lossy(&output).trim().to_owned())
}

/// Runs git with `args` in `path` and returns its raw stdout.
fn git_bytes(path: &Path, args: &[&str]) -> Result<Vec<u8>, Error> {
    git_bytes_with_env(path, args, &[])
}

/// The engine's git runner (argv, redirecting variables scrubbed) plus `env`, raw stdout.
fn git_bytes_with_env(
    path: &Path,
    args: &[&str],
    env: &[(&str, String)],
) -> Result<Vec<u8>, Error> {
    let mut command = git_core::cli::command(path, args);
    for (key, value) in env {
        command.env(key, value);
    }
    let output = command.output().map_err(|source| Error::Io {
        context: format!("run git {}", args.join(" ")),
        source,
    })?;
    if !output.status.success() {
        return Err(Error::Io {
            context: format!("git {}", args.join(" ")),
            source: std::io::Error::other(String::from_utf8_lossy(&output.stderr).into_owned()),
        });
    }
    Ok(output.stdout)
}
