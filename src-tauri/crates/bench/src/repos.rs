//! Where the benchmark repositories live.

use std::path::{Path, PathBuf};

/// Clone URL of the large real repository.
pub const REAL_URL: &str = "https://github.com/torvalds/linux.git";

/// The folder holding every benchmark repository: `BEGIRA_BENCH_REPOS` when set, otherwise
/// `bench/repos` at the repository root.
pub fn repos_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("BEGIRA_BENCH_REPOS") {
        return PathBuf::from(dir);
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../bench/repos")
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

/// Whether `path` is a git working tree with at least one commit.
pub fn is_repository(path: &Path) -> bool {
    git2::Repository::open(path)
        .ok()
        .and_then(|repo| repo.head().ok().and_then(|head| head.target()))
        .is_some()
}
