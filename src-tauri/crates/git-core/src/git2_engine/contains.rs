//! The refs whose history holds a commit ("Contained in" in the detail panel).
//!
//! The tips are read once, with libgit2: the branches, the remote branches without a remote's
//! symbolic `HEAD`, and the tags peeled to their commit, skipping what git skips (a name git
//! refuses, a ref whose object is missing or unreadable, a tag of a tree or a blob). Then:
//! - with a commit-graph file, `git for-each-ref --contains` answers: its generation numbers
//!   stop each ref's check at the commit (a fifth of a second on the kernel benchmark, where a
//!   walk of its 1.48 million commits takes three);
//! - without one, one walk of every commit of those tips, parents before children
//!   (`git rev-list --stdin --topo-order --reverse --parents`, the tips on stdin), keeps each
//!   commit that is the commit or has a kept parent; a ref holds the commit when its tip is
//!   kept. `for-each-ref --contains` would walk each ref that does not hold the commit down
//!   to the root there, minutes on the kernel.
//!
//! No date bounds the walk: a commit made with a clock behind the commits it holds (a rebase
//! with `--committer-date-is-author-date`, a tool that sets the committer date) is not missed,
//! as a walk cut at the commit's date misses it. The walk holds the kept set alone, never the
//! graph. Its tips are the ones read: a broken ref git's own listing of the refs would die on
//! never reaches it, and a ref another process moves meanwhile counts with the tip read.

use std::collections::HashSet;
use std::path::Path;

use git2::{ErrorCode, Oid, ReferenceType, Repository};

use super::Git2Engine;
use crate::cli;
use crate::engine::{Cancel, GitEngine};
use crate::error::{GitError, GitResult};

/// The walk: every commit of the tips given on stdin, each line a commit and its parents,
/// parents first.
const WALK: [&str; 5] = [
    "rev-list",
    "--stdin",
    "--topo-order",
    "--reverse",
    "--parents",
];

/// Lists the full names of the refs whose history holds `commit`; see the module docs.
#[tracing::instrument(level = "debug", skip(engine, cancel))]
pub(super) fn refs_containing(
    engine: &Git2Engine,
    commit: &str,
    cancel: &Cancel,
) -> GitResult<Vec<String>> {
    cancel.check()?;
    let repo_info = GitEngine::repo(engine);
    let (target, tips, graph) = engine.with_repo(|repo| {
        Ok((
            commit_of(repo, commit)?,
            tips(repo)?,
            has_commit_graph(repo, &repo_info.common_dir),
        ))
    })?;
    if tips.is_empty() {
        return Ok(Vec::new());
    }
    let holding = if graph {
        listed_by_git(&repo_info.root, target, cancel)?
    } else {
        walked(&repo_info.root, target, &tips, cancel)?
    };
    Ok(tips
        .into_iter()
        .filter(|(name, tip)| holding.holds(name, tip))
        .map(|(name, _)| name)
        .collect())
}

/// What an answer is made of: the refs git named, or the commits the walk kept.
enum Holding {
    Names(HashSet<String>),
    Commits(HashSet<Oid>),
}

impl Holding {
    fn holds(&self, name: &str, tip: &Oid) -> bool {
        match self {
            Holding::Names(names) => names.contains(name),
            Holding::Commits(commits) => commits.contains(tip),
        }
    }
}

/// git's own answer, for a repository with a commit-graph file.
fn listed_by_git(root: &Path, target: Oid, cancel: &Cancel) -> GitResult<Holding> {
    let hash = target.to_string();
    let args = [
        "for-each-ref",
        "--format=%(refname)",
        "--contains",
        hash.as_str(),
        "refs/heads",
        "refs/remotes",
        "refs/tags",
    ];
    let exit = cli::run_git_cancellable(root, &args, cancel)?;
    if exit.status != Some(0) {
        return Err(exit.into_failure(&args));
    }
    let listed = String::from_utf8_lossy(&exit.stdout);
    Ok(Holding::Names(listed.lines().map(str::to_owned).collect()))
}

/// The commits that reach `target`, from one parents-first walk of the `tips`.
fn walked(root: &Path, target: Oid, tips: &[(String, Oid)], cancel: &Cancel) -> GitResult<Holding> {
    let mut input = Vec::with_capacity(tips.len() * 41);
    let mut fed = HashSet::with_capacity(tips.len());
    for (_, tip) in tips {
        if fed.insert(*tip) {
            input.extend_from_slice(tip.to_string().as_bytes());
            input.push(b'\n');
        }
    }
    let mut kept: HashSet<Oid> = HashSet::from([target]);
    let mut unreadable = None;
    let exit = cli::run_git_lines_with_input(root, &WALK, input, cancel, &mut |line| {
        if unreadable.is_some() {
            return;
        }
        match reaches(line, &kept) {
            Some((commit, true)) => {
                kept.insert(commit);
            }
            Some((_, false)) => {}
            None => unreadable = Some(String::from_utf8_lossy(line).into_owned()),
        }
    })?;
    if exit.status != Some(0) {
        return Err(exit.into_failure(&WALK));
    }
    if let Some(line) = unreadable {
        return Err(GitError::Cli {
            command: cli::joined(&WALK),
            status: exit.status,
            stderr: format!("unexpected rev-list output {line:?}"),
        });
    }
    Ok(Holding::Commits(kept))
}

/// A line of the walk read against the kept set: the commit, and whether one of its parents
/// is kept; `None` for a line that is not hashes.
fn reaches(line: &[u8], kept: &HashSet<Oid>) -> Option<(Oid, bool)> {
    let text = std::str::from_utf8(line).ok()?;
    let mut hashes = text.split(' ');
    let commit = Oid::from_str(hashes.next()?).ok()?;
    let mut reached = false;
    for parent in hashes {
        reached |= kept.contains(&Oid::from_str(parent).ok()?);
    }
    Some((commit, reached))
}

/// The commit a full hash names. [`GitError::RefNotFound`] for anything else: a name, a short
/// hash, a hash the repository has not, the hash of a tag, a tree or a blob. A commit that
/// cannot be read is [`GitError::CorruptObject`].
fn commit_of(repo: &Repository, commit: &str) -> GitResult<Oid> {
    let not_found = || GitError::RefNotFound(commit.to_owned());
    let oid = super::full_oid(commit).ok_or_else(not_found)?;
    match repo.find_commit(oid) {
        Ok(found) => Ok(found.id()),
        Err(error) if error.code() == ErrorCode::NotFound => Err(not_found()),
        Err(error) => Err(GitError::object(commit, error)),
    }
}

/// The refs an answer is made of, with the commit each one holds, in the repository's order:
/// the branches, the remote branches without a remote's symbolic `HEAD` (the refs listing
/// leaves it out), and the tags peeled to their commit. Left out as git leaves them out: a
/// name git refuses, a ref whose object is missing or unreadable, a tag of a tree or a blob;
/// and a name that is not UTF-8, which the answer cannot carry. A failed read of the refs is
/// an error, never an empty answer.
fn tips(repo: &Repository) -> GitResult<Vec<(String, Oid)>> {
    let mut tips = Vec::new();
    for reference in repo.references()? {
        let reference = reference?;
        let Ok(name) = reference.name() else {
            continue;
        };
        let wanted = name.starts_with("refs/heads/")
            || name.starts_with("refs/tags/")
            || (name.starts_with("refs/remotes/")
                && reference.kind() != Some(ReferenceType::Symbolic));
        if !wanted || !git2::Reference::is_valid_name(name) {
            continue;
        }
        let Ok(commit) = reference.peel_to_commit() else {
            continue;
        };
        tips.push((name.to_owned(), commit.id()));
    }
    Ok(tips)
}

/// Whether git keeps a commit-graph file for the repository and reads it (`core.commitGraph`,
/// on unless the configuration turns it off).
fn has_commit_graph(repo: &Repository, common_dir: &Path) -> bool {
    let info = common_dir.join("objects").join("info");
    let present = info.join("commit-graph").is_file()
        || info
            .join("commit-graphs")
            .join("commit-graph-chain")
            .is_file();
    present
        && repo
            .config()
            .and_then(|config| config.get_bool("core.commitGraph"))
            .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(cwd: &Path, args: &[&str]) {
        let output = cli::command(cwd, args).output().expect("git runs");
        assert!(output.status.success(), "git {args:?} failed");
    }

    #[test]
    fn knows_a_commit_graph_file_and_a_configuration_that_turns_it_off() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        git(root, &["init", "-q", "-b", "main"]);
        git(root, &["config", "user.email", "t@x"]);
        git(root, &["config", "user.name", "t"]);
        git(root, &["commit", "-q", "--allow-empty", "-m", "c1"]);
        let repo = Repository::open(root).expect("open");
        let common = root.join(".git");
        assert!(!has_commit_graph(&repo, &common));
        git(root, &["commit-graph", "write", "--reachable"]);
        assert!(has_commit_graph(&repo, &common));
        git(root, &["config", "core.commitGraph", "false"]);
        let repo = Repository::open(root).expect("open again");
        assert!(!has_commit_graph(&repo, &common));
    }

    #[test]
    fn reads_a_line_of_the_walk_against_the_kept_set() {
        let one = Oid::from_str(&"1".repeat(40)).expect("oid");
        let two = Oid::from_str(&"2".repeat(40)).expect("oid");
        let three = Oid::from_str(&"3".repeat(40)).expect("oid");
        let kept = HashSet::from([one]);
        let line = format!("{two} {three} {one}");
        assert_eq!(reaches(line.as_bytes(), &kept), Some((two, true)));
        assert_eq!(
            reaches(format!("{two} {three}").as_bytes(), &kept),
            Some((two, false))
        );
        assert_eq!(
            reaches(two.to_string().as_bytes(), &kept),
            Some((two, false))
        );
        assert_eq!(reaches(b"fatal: not a hash", &kept), None);
        assert_eq!(reaches(format!("{two} nope").as_bytes(), &kept), None);
    }
}
