//! `bench fetch-real`: clone the large real repository, or verify the existing clone.

use std::path::Path;

use git_core::cli::run_git;

use crate::repos::{is_repository, REAL_URL};
use crate::{Error, Result};

/// What `fetch-real` did.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// A valid clone was already there; nothing was downloaded.
    Verified {
        /// Its HEAD hash.
        head: String,
    },
    /// The repository was cloned.
    Cloned {
        /// Its HEAD hash.
        head: String,
    },
}

/// Clones `url` into `out` unless `out` already holds a repository with commits, in which case
/// it is verified (`git rev-parse HEAD`) and left alone. A folder that exists but is not a
/// usable repository (an interrupted clone) is removed and cloned again: git cannot resume a
/// clone, so "resume" means starting over from a clean folder.
pub fn run(out: &Path, url: &str) -> Result<Outcome> {
    if out.exists() {
        if is_repository(out) {
            let head = run_git(out, &["rev-parse", "HEAD"])?
                .stdout
                .trim()
                .to_owned();
            return Ok(Outcome::Verified { head });
        }
        // Only an interrupted clone (a `.git` folder without commits) is started over;
        // anything else at that path is someone's data and stays.
        let interrupted = out.join(".git").is_dir();
        if !interrupted {
            return Err(Error::Usage(format!(
                "{} exists and is not a git clone; remove it or pass another --out",
                out.display()
            )));
        }
        std::fs::remove_dir_all(out)
            .map_err(|source| Error::io(format!("remove {}", out.display()), source))?;
    }
    let parent = out.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)
        .map_err(|source| Error::io(format!("create {}", parent.display()), source))?;
    let target = out
        .to_str()
        .ok_or_else(|| Error::Usage("the output path must be valid UTF-8".to_owned()))?;
    run_git(parent, &["clone", "--progress", url, target])?;
    let head = run_git(out, &["rev-parse", "HEAD"])?
        .stdout
        .trim()
        .to_owned();
    Ok(Outcome::Cloned { head })
}

/// The default URL, for the CLI.
pub fn default_url() -> &'static str {
    REAL_URL
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_an_existing_clone_without_downloading() {
        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir.path().join("source");
        let repo = git2::Repository::init(&source).expect("init");
        let sig = git2::Signature::now("t", "t@x").expect("sig");
        let tree_id = repo.index().expect("index").write_tree().expect("tree");
        let tree = repo.find_tree(tree_id).expect("tree");
        let head = repo
            .commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .expect("commit");

        let outcome = run(&source, "file:///nowhere").expect("verified");
        assert_eq!(
            outcome,
            Outcome::Verified {
                head: head.to_string()
            }
        );
    }

    #[test]
    fn clones_from_a_local_source_and_replaces_an_interrupted_clone() {
        let dir = tempfile::tempdir().expect("temp dir");
        let source = dir.path().join("source");
        let repo = git2::Repository::init(&source).expect("init");
        let sig = git2::Signature::now("t", "t@x").expect("sig");
        let tree_id = repo.index().expect("index").write_tree().expect("tree");
        let tree = repo.find_tree(tree_id).expect("tree");
        let head = repo
            .commit(Some("HEAD"), &sig, &sig, "init", &tree, &[])
            .expect("commit");

        let url = source.to_str().expect("utf-8");

        // A folder with anything but an interrupted clone is left alone.
        let out = dir.path().join("real");
        std::fs::create_dir_all(&out).expect("folder");
        std::fs::write(out.join("garbage"), b"x").expect("garbage");
        assert!(matches!(run(&out, url), Err(Error::Usage(_))));
        assert!(out.join("garbage").exists());

        // An interrupted clone (a `.git` without commits) is started over.
        std::fs::remove_file(out.join("garbage")).expect("remove");
        git2::Repository::init(&out).expect("empty clone");
        std::fs::write(out.join("leftover"), b"x").expect("leftover");
        let outcome = run(&out, url).expect("cloned");
        assert_eq!(
            outcome,
            Outcome::Cloned {
                head: head.to_string()
            }
        );
        assert!(!out.join("leftover").exists());
    }
}
