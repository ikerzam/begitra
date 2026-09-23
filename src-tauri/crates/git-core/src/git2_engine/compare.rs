//! Two revisions side by side: the merge base, the commits only on each side from
//! libgit2's bounded `graph_ahead_behind` (what `git rev-list --left-right --count a...b`
//! prints), the relation between the endpoints, and the merge preview. Fast-forward and
//! up-to-date come from the counts; a diverged pair asks `git merge-tree --write-tree`, the
//! algorithm `git merge` runs in the user's terminal, through argv and killed on cancel. The
//! preview changes no ref, index or working tree; git stores the merged result as
//! unreferenced objects that `git gc` prunes.

use git2::{Oid, Repository};

use super::Git2Engine;
use crate::cli::run_git_cancellable;
use crate::engine::{Cancel, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{
    BaseCommit, Comparison, ComparisonRelation, Endpoint, MergePreview, MergePreviewKind,
};

/// Compares `a` with `b`; see [`crate::engine::GitEngine::compare`].
///
/// The revisions and the merge base resolve on the engine's main handle (the base is what
/// a cold handle pays most for); the counts, which walk every commit on either side and take
/// seconds for a pair diverged by hundreds of thousands of commits, run on the engine's
/// comparison handle so the other operations are not held meanwhile. That handle is kept
/// between comparisons: its object cache makes a repeated or nearby pair four times faster
/// than a fresh handle (36 ms against 147 ms on the kernel pair of the benchmarks). libgit2
/// offers no way to interrupt the walk: a cancelled comparison ends when the walk does.
#[tracing::instrument(level = "debug", skip_all, fields(a = %a, b = %b))]
pub(super) fn compare(
    engine: &Git2Engine,
    a: &str,
    b: &str,
    cancel: &Cancel,
) -> GitResult<Comparison> {
    cancel.check()?;
    let (pair, gitdir) = engine
        .with_repo(|repo| Ok((resolve_pair(engine, repo, a, b)?, repo.path().to_path_buf())))?;
    cancel.check()?;
    let (only_in_a, only_in_b) = engine.with_counts_repo(&gitdir, |repo| {
        Ok(repo.graph_ahead_behind(pair.one, pair.two)?)
    })?;
    let only_in_a = u32::try_from(only_in_a).unwrap_or(u32::MAX);
    let only_in_b = u32::try_from(only_in_b).unwrap_or(u32::MAX);
    Ok(Comparison {
        a: Endpoint {
            rev: a.to_owned(),
            hash: pair.one.to_string(),
        },
        b: Endpoint {
            rev: b.to_owned(),
            hash: pair.two.to_string(),
        },
        base: BaseCommit {
            hash: pair.base.to_string(),
            time: pair.base_time,
        },
        only_in_a,
        only_in_b,
        relation: relation(pair.one, pair.two, only_in_a, only_in_b),
    })
}

/// The two endpoints resolved with their merge base.
struct Pair {
    one: Oid,
    two: Oid,
    base: Oid,
    base_time: i64,
}

fn resolve_pair(engine: &Git2Engine, repo: &Repository, a: &str, b: &str) -> GitResult<Pair> {
    let one = super::resolve_commit(repo, a)?;
    let two = super::resolve_commit(repo, b)?;
    // Remembered by the engine: the files of the comparison read at the merge base next.
    let base = super::refs::unrelated_as_error(engine.merge_base_of(repo, one, two), a, b)?;
    let base_time = repo
        .find_commit(base)
        .map_err(|error| GitError::object(&base.to_string(), error))?
        .time()
        .seconds();
    Ok(Pair {
        one,
        two,
        base,
        base_time,
    })
}

/// The relation the hashes and the counts imply.
fn relation(a: Oid, b: Oid, only_in_a: u32, only_in_b: u32) -> ComparisonRelation {
    if a == b {
        ComparisonRelation::Same
    } else if only_in_a == 0 {
        ComparisonRelation::FastForward
    } else if only_in_b == 0 {
        ComparisonRelation::UpToDate
    } else {
        ComparisonRelation::Diverged
    }
}

/// Previews the merge of `b` into `a`; see [`crate::engine::GitEngine::merge_preview`].
#[tracing::instrument(level = "debug", skip_all, fields(a = %a, b = %b))]
pub(super) fn merge_preview(
    engine: &Git2Engine,
    a: &str,
    b: &str,
    cancel: &Cancel,
) -> GitResult<MergePreview> {
    let comparison = compare(engine, a, b, cancel)?;
    match comparison.relation {
        ComparisonRelation::Same | ComparisonRelation::UpToDate => {
            return Ok(MergePreview {
                kind: MergePreviewKind::UpToDate,
                conflicts: Vec::new(),
            });
        }
        ComparisonRelation::FastForward => {
            return Ok(MergePreview {
                kind: MergePreviewKind::FastForward,
                conflicts: Vec::new(),
            });
        }
        ComparisonRelation::Diverged => {}
    }
    // The resolved hashes go to git, so a name that means something else to git (an
    // ambiguous short name) cannot change the verdict.
    let args = [
        "merge-tree",
        "--write-tree",
        "--name-only",
        "--no-messages",
        "-z",
        comparison.a.hash.as_str(),
        comparison.b.hash.as_str(),
    ];
    let exit = run_git_cancellable(&GitEngine::repo(engine).root, &args, cancel)?;
    match exit.status {
        Some(0) => Ok(MergePreview {
            kind: MergePreviewKind::Clean,
            conflicts: Vec::new(),
        }),
        Some(1) => Ok(MergePreview {
            kind: MergePreviewKind::Conflicts,
            conflicts: conflicted_paths(&exit.stdout, &[&comparison.a.hash, &comparison.b.hash]),
        }),
        status => Err(GitError::Cli {
            command: args.join(" "),
            status,
            stderr: exit.stderr,
        }),
    }
}

/// The conflicted paths of `git merge-tree --write-tree --name-only -z`: after the tree id,
/// one NUL-terminated path each, sorted and unique.
///
/// A directory/file conflict moves the file aside under `<path>~<label>` (and `_<n>` when
/// that is taken), the label being the argument git was given for that side: here a hash,
/// which `git merge` in a terminal would print as the branch name. The suffix is dropped so
/// the list names the path the user can open.
fn conflicted_paths(stdout: &[u8], labels: &[&str]) -> Vec<String> {
    let unlabelled = |path: &str| -> String {
        for label in labels {
            let Some((head, tail)) = path.rsplit_once('~') else {
                continue;
            };
            let numbered = tail
                .strip_prefix(label)
                .and_then(|rest| rest.strip_prefix('_'))
                .is_some_and(|digits| {
                    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
                });
            if !head.is_empty() && (tail == *label || numbered) {
                return head.to_owned();
            }
        }
        path.to_owned()
    };
    let mut paths: Vec<String> = stdout
        .split(|&byte| byte == 0)
        .skip(1)
        .filter(|part| !part.is_empty())
        .map(|part| unlabelled(&String::from_utf8_lossy(part)))
        .collect();
    paths.sort();
    paths.dedup();
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflicted_paths_are_parsed_sorted_and_unique() {
        let output = b"0123abcd\0src/b.ts\0src/a.ts\0src/b.ts\0";
        assert_eq!(conflicted_paths(output, &[]), vec!["src/a.ts", "src/b.ts"]);
        assert!(conflicted_paths(b"0123abcd\0", &[]).is_empty());
        assert!(conflicted_paths(b"", &[]).is_empty());
    }

    #[test]
    fn directory_file_conflicts_lose_the_side_label() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let output = format!("0123abcd\0thing~{a}\0other~{b}_2\0kept~{a}x\0~{a}\0");
        assert_eq!(
            conflicted_paths(output.as_bytes(), &[&a, &b]),
            vec![
                format!("kept~{a}x"),
                "other".to_owned(),
                "thing".to_owned(),
                format!("~{a}")
            ]
        );
    }

    #[test]
    fn relations_follow_the_counts() {
        let a = Oid::from_str("a".repeat(40).as_str()).expect("oid");
        let b = Oid::from_str("b".repeat(40).as_str()).expect("oid");
        assert_eq!(relation(a, a, 0, 0), ComparisonRelation::Same);
        assert_eq!(relation(a, b, 0, 3), ComparisonRelation::FastForward);
        assert_eq!(relation(a, b, 2, 0), ComparisonRelation::UpToDate);
        assert_eq!(relation(a, b, 2, 3), ComparisonRelation::Diverged);
    }
}
