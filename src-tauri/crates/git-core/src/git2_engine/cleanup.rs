//! The branches that can go and their deletion with their worktrees. The listing reads the refs
//! and their upstreams with one `git for-each-ref`, asks git which branches the main branch or
//! its upstream holds (`--merged`, one walk for both) and, for the gone ones, whether merging
//! them would change it (one batch of `git merge-tree --stdin`, the newest first under a time
//! budget, its objects in a folder of its own); the deletion goes through `git worktree remove`
//! and `git branch -D`, each branch only while its tip is the one listed.

use std::borrow::Cow;
use std::collections::HashSet;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Once;
use std::thread;
use std::time::Duration;

use git2::{ErrorCode, Oid};

use super::staging::judged;
use super::{worktree_ops, worktrees, Git2Engine};
use crate::cli::{
    network_env, run_git_cancellable, run_git_env_with_input_for, run_git_env_within, WRITE_ENV,
};
use crate::engine::{Cancel, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{
    BranchToDelete, CleanupCandidate, CleanupCandidates, CleanupReason, DeleteOutcome, KeptReason,
    Prompts, Worktree,
};

/// The longest one git run of a deletion may take: the runs ignore the cancel, so that a
/// removal never stops half way, and this bounds each instead (a worktree with a large
/// `node_modules` takes seconds).
const RUN_LIMIT: Duration = Duration::from_secs(600);

/// How long the merge check may run before the gone branches it has not answered read as not
/// checked: the dialog waits on the listing, and a branch forked long ago takes seconds to merge
/// (git reads every tree the main branch changed since). The newest go first; fifty recently
/// squash-merged branches answer in a third of a second.
const MERGE_CHECK_BUDGET: Duration = Duration::from_secs(3);

/// The start of a merge check's folder's name, right in the system's temp folder.
const SCRATCH_PREFIX: &str = "begitra-merge-check-";

/// How many names a merge check tries for its folder: a name already taken (a leftover of a
/// process whose id this one reuses, another user's on a shared `/tmp`) moves on to the next.
const SCRATCH_ATTEMPTS: usize = 16;

/// How old a merge check's folder is when it is surely left over (a check killed while git still
/// wrote in it): no check runs that long, so a later process removes it.
const STALE_SCRATCH: Duration = Duration::from_secs(3600);

/// A ref as `git for-each-ref` lists it.
struct Listed {
    /// Full name (`refs/heads/main`).
    name: String,
    /// The commit it points at (a symbolic ref's target's).
    tip: String,
    /// Its upstream's full name as configured (`refs/remotes/origin/x`, or `refs/heads/y` for a
    /// local one), also while that ref is gone; empty without one.
    upstream: String,
    /// Its upstream's remote (`origin`, `.` for a local upstream).
    remote: String,
    /// What a symbolic ref points at; empty for a direct one.
    symref: String,
    /// Unix seconds of its tip's committer date; 0 when git gives none.
    date: i64,
}

/// Branch names as the repository's disk compares them: with `core.ignorecase` (a
/// case-insensitive disk, where `Feature` and `feature` are one loose ref) case is folded, so a
/// name HEAD or a worktree spells another way still counts as the same branch.
pub(super) struct Names {
    ignore_case: bool,
}

impl Names {
    fn of(engine: &Git2Engine) -> GitResult<Self> {
        engine.with_repo(|repo| Ok(Self::of_repo(repo)))
    }

    /// The names of `repo`'s disk.
    pub(super) fn of_repo(repo: &git2::Repository) -> Self {
        let ignore_case = repo
            .config()
            .and_then(|config| config.get_bool("core.ignorecase"))
            .unwrap_or(false);
        Self { ignore_case }
    }

    fn key<'a>(&self, name: &'a str) -> Cow<'a, str> {
        if self.ignore_case {
            Cow::Owned(name.chars().flat_map(char::to_lowercase).collect())
        } else {
            Cow::Borrowed(name)
        }
    }

    pub(super) fn same(&self, a: &str, b: &str) -> bool {
        if self.ignore_case {
            a.chars()
                .flat_map(char::to_lowercase)
                .eq(b.chars().flat_map(char::to_lowercase))
        } else {
            a == b
        }
    }
}

/// What the listing reads through libgit2 in one hold of the repository.
struct Read {
    /// The branch HEAD has checked out here.
    head: Option<String>,
    /// Each base of the checks (the main branch, then its upstream when it differs) with its tree.
    bases: Vec<(String, String)>,
    /// The upstreams `git for-each-ref` did not list that the ref store lacks too: gone.
    missing: HashSet<String>,
    /// The merge drivers the configuration names (`merge.<name>.driver`).
    drivers: Vec<String>,
}

/// See [`crate::engine::GitEngine::cleanup_candidates`].
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn cleanup_candidates(
    engine: &Git2Engine,
    cancel: &Cancel,
) -> GitResult<CleanupCandidates> {
    let repo = GitEngine::repo(engine);
    let (root, common_dir) = (repo.root.clone(), repo.common_dir.clone());
    let worktrees = worktrees::list(engine, cancel)?;
    let refs = listed_refs(&root, cancel)?;
    let locals: Vec<(&str, &Listed)> = refs
        .iter()
        .filter(|listed| listed.symref.is_empty())
        .filter_map(|listed| Some((listed.name.strip_prefix("refs/heads/")?, listed)))
        .collect();
    let local = |name: &str| {
        locals
            .iter()
            .find(|(short, _)| *short == name)
            .map(|(_, l)| *l)
    };
    // The local branch named like the one origin/HEAD points at, else main, else master; never
    // guessed from what a worktree has checked out, which would take a feature for the main line.
    let origin_head = refs
        .iter()
        .find(|listed| listed.name == "refs/remotes/origin/HEAD")
        .and_then(|head| head.symref.strip_prefix("refs/remotes/origin/"));
    let Some((main, main_ref)) = origin_head
        .into_iter()
        .chain(["main", "master"])
        .find_map(|name| local(name).map(|listed| (name, listed)))
    else {
        return Ok(CleanupCandidates {
            main: None,
            candidates: Vec::new(),
        });
    };
    let main_tip = main_ref.tip.as_str();
    // The main branch's upstream counts when it is a remote's branch (a pull request merged there
    // while the local main is behind); a local upstream is no main line.
    let upstream_tip = refs
        .iter()
        .find(|listed| {
            main_ref.upstream.starts_with("refs/remotes/") && listed.name == main_ref.upstream
        })
        .map(|listed| listed.tip.as_str());
    // The upstreams on the main line: a branch made from it tracks one of these.
    let mut main_line = vec![format!("refs/heads/{main}")];
    if main_ref.upstream.starts_with("refs/remotes/") {
        main_line.push(main_ref.upstream.clone());
    }
    let present: HashSet<&str> = refs.iter().map(|listed| listed.name.as_str()).collect();
    let unlisted: Vec<&str> = locals
        .iter()
        .map(|(_, listed)| listed.upstream.as_str())
        .filter(|upstream| !upstream.is_empty() && !present.contains(upstream))
        .collect();
    let names = Names::of(engine)?;
    let read = engine.with_repo(|repo| {
        let head = repo.find_reference("HEAD").ok().and_then(|head| {
            head.symbolic_target()
                .ok()
                .flatten()
                .and_then(|target| target.strip_prefix("refs/heads/"))
                .map(str::to_owned)
        });
        let tree = |tip: &str| -> GitResult<String> {
            Ok(repo.find_commit(Oid::from_str(tip)?)?.tree_id().to_string())
        };
        let mut bases = vec![(main_tip.to_owned(), tree(main_tip)?)];
        if let Some(upstream) = upstream_tip.filter(|upstream| *upstream != main_tip) {
            bases.push((upstream.to_owned(), tree(upstream)?));
        }
        // A remote's fetch refspec can map its branches outside refs/remotes/, and a
        // case-insensitive disk resolves an upstream spelled another way: the ref store says
        // which of the upstreams the listing lacks are gone. Only a ref that is not found is.
        let missing = unlisted
            .iter()
            .filter(|upstream| {
                matches!(repo.find_reference(upstream), Err(error) if error.code() == ErrorCode::NotFound)
            })
            .map(|upstream| (*upstream).to_owned())
            .collect();
        let mut drivers = Vec::new();
        if let Ok(config) = repo.config() {
            if let Ok(mut entries) = config.entries(Some(r"^merge\..+\.driver$")) {
                while let Some(entry) = entries.next() {
                    if let Ok(name) = entry.and_then(|entry| entry.name().map(str::to_owned)) {
                        drivers.push(name);
                    }
                }
            }
        }
        Ok(Read {
            head,
            bases,
            missing,
            drivers,
        })
    })?;
    // Never listed: the main line, what HEAD has checked out, the main worktree's branch, what a
    // worktree whose folder is missing holds (git refuses its deletion until the worktree goes),
    // and what git counts as in use by a rebase or a bisect.
    let mut kept: HashSet<String> = HashSet::new();
    kept.insert(names.key(main).into_owned());
    if let Some(head) = read.head.as_deref() {
        kept.insert(names.key(head).into_owned());
    }
    for worktree in &worktrees {
        if worktree.is_main || worktree.prunable || !worktree.path.exists() {
            if let Some(branch) = worktree.branch.as_deref() {
                kept.insert(names.key(branch).into_owned());
            }
        }
    }
    for name in in_use(&common_dir, &worktrees) {
        kept.insert(names.key(&name).into_owned());
    }
    let base_tips: Vec<&str> = read.bases.iter().map(|(tip, _)| tip.as_str()).collect();
    let merged = merged_into(&root, &base_tips, cancel)?;
    let mut found: Vec<(&str, &Listed, Option<CleanupReason>)> = Vec::new();
    for (name, listed) in &locals {
        cancel.check()?;
        if kept.contains(names.key(name).as_ref()) {
            continue;
        }
        if merged.contains(*name) {
            let reflog = common_dir.join("logs/refs/heads").join(name);
            let reason = if no_commits(listed, &read.bases, &main_line, &reflog) {
                CleanupReason::NoCommits
            } else {
                CleanupReason::Merged
            };
            found.push((name, listed, Some(reason)));
        } else if read.missing.contains(&listed.upstream) {
            // Gone; applied or not once the merges below answer.
            found.push((name, listed, None));
        }
    }
    let gone = newest_first(
        found
            .iter()
            .filter(|(_, _, reason)| reason.is_none())
            .map(|(_, listed, _)| (listed.tip.as_str(), listed.date))
            .collect(),
    );
    let checked = check_merges(
        &root,
        &common_dir,
        &read.bases,
        &read.drivers,
        &gone,
        cancel,
        MERGE_CHECK_BUDGET,
    )?;
    let mut candidates: Vec<CleanupCandidate> = found
        .into_iter()
        .map(|(name, listed, reason)| CleanupCandidate {
            name: name.to_owned(),
            tip: listed.tip.clone(),
            reason: reason.unwrap_or_else(|| checked.reason(&listed.tip)),
            remote: (!listed.remote.is_empty() && listed.remote != ".")
                .then(|| listed.remote.clone()),
            worktree: linked_worktree_of(&worktrees, name, &names),
        })
        .collect();
    candidates.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(CleanupCandidates {
        main: Some(main.to_owned()),
        candidates,
    })
}

/// The local and remote-tracking refs with their tips and upstreams, as git lists them: one
/// process outside the repository's lock, where libgit2 reads each upstream from a fresh copy
/// of the configuration and grows with the square of the tracking branches.
fn listed_refs(root: &Path, cancel: &Cancel) -> GitResult<Vec<Listed>> {
    let args = [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:remotename)%00%(symref)%00%(committerdate:unix)",
        "refs/heads/",
        "refs/remotes/",
    ];
    let exit = judged(&args, run_git_cancellable(root, &args, cancel)?)?;
    Ok(String::from_utf8_lossy(&exit.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\0');
            Some(Listed {
                name: fields.next()?.to_owned(),
                tip: fields.next()?.to_owned(),
                upstream: fields.next()?.to_owned(),
                remote: fields.next()?.to_owned(),
                symref: fields.next()?.to_owned(),
                date: fields
                    .next()
                    .and_then(|date| date.parse().ok())
                    .unwrap_or(0),
            })
        })
        .collect())
}

/// The local branches whose tip is reachable from any of `tips`, by short name: one walk of the
/// history for all, as git reads several `--merged` (git 2.29). Without a commit-graph that walk
/// reads the main branch's whole history whenever a branch is not in it.
fn merged_into(root: &Path, tips: &[&str], cancel: &Cancel) -> GitResult<HashSet<String>> {
    let merged: Vec<String> = tips.iter().map(|tip| format!("--merged={tip}")).collect();
    let mut args = vec!["for-each-ref", "--format=%(refname)"];
    args.extend(merged.iter().map(String::as_str));
    args.push("refs/heads/");
    let exit = judged(&args, run_git_cancellable(root, &args, cancel)?)?;
    Ok(String::from_utf8_lossy(&exit.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix("refs/heads/"))
        .map(str::to_owned)
        .collect())
}

/// Whether a merged branch has no commits of its own. With a reflog: it never moved since it was
/// made (every entry's new commit is its tip: a creation, a rename, a copy) and it is on the main
/// line (no upstream, the main branch's upstream or the main branch itself) or at one of the
/// bases' tips; a commit, a reset or a pull in its reflog is work of its own, even fast-forwarded
/// into main, and a branch made from another remote branch carries commits made elsewhere.
/// Without a reflog (a bare repository's default): at one of the bases' tips.
fn no_commits(
    listed: &Listed,
    bases: &[(String, String)],
    main_line: &[String],
    reflog: &Path,
) -> bool {
    let at_base = bases.iter().any(|(tip, _)| *tip == listed.tip);
    let Ok(text) = fs::read_to_string(reflog) else {
        return at_base;
    };
    if text.lines().next().is_none() {
        return at_base;
    }
    // `<old> <new> <who> <when>\t<message>`.
    let still = text
        .lines()
        .all(|entry| entry.split(' ').nth(1) == Some(listed.tip.as_str()));
    still && (at_base || listed.upstream.is_empty() || main_line.contains(&listed.upstream))
}

/// The gone tips in the order the merge check takes them: the newest commit first, since a branch
/// forked long ago merges slowest and is the one the budget may leave unanswered; each tip once.
fn newest_first(mut tips: Vec<(&str, i64)>) -> Vec<&str> {
    tips.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    tips.dedup_by(|later, kept| later.0 == kept.0);
    tips.into_iter().map(|(tip, _)| tip).collect()
}

/// What the merge check answered: the gone tips it checked, and those of them a base already
/// holds the changes of.
#[derive(Default)]
struct Checked {
    answered: HashSet<String>,
    applied: HashSet<String>,
}

impl Checked {
    fn reason(&self, tip: &str) -> CleanupReason {
        if self.applied.contains(tip) {
            CleanupReason::GoneApplied
        } else if self.answered.contains(tip) {
            CleanupReason::Gone
        } else {
            CleanupReason::GoneUnchecked
        }
    }
}

/// The merge check of the gone tips, in `gone`'s order: whether each merges into a base (the
/// main branch, its upstream) without changing its tree, which is what a squash or a rebase
/// merge leaves. One `git merge-tree --stdin` for every pair (git 2.39), which writes each answer
/// as its merge ends; past `budget` git is stopped, and a tip without all its answers reads as
/// not checked. Every merge driver the configuration names is made to report a conflict, and so
/// is git's own union driver, which keeps both sides' lines and never reports one (git takes a
/// configured driver before a built-in of the same name): a driver that keeps one side or both,
/// named in `.gitattributes`, `.git/info/attributes`, the user's attributes file or
/// `merge.default`, would otherwise hide the branch's changes; git's binary driver reports its
/// conflicts already. The merged objects go to a folder of its own, removed
/// after, so the listing writes no object to the repository (git still freshens the time of a
/// pack holding an object a merge makes again); a partial clone fetches nothing for it
/// (`GIT_NO_LAZY_FETCH`, git 2.45; nothing may ask for a sign-in either). A git before 2.39 or a
/// folder that cannot be made answers nothing, and a git that stops on an object a partial clone
/// lacks answers the merges before it.
fn check_merges(
    root: &Path,
    common_dir: &Path,
    bases: &[(String, String)],
    drivers: &[String],
    gone: &[&str],
    cancel: &Cancel,
    budget: Duration,
) -> GitResult<Checked> {
    let mut checked = Checked::default();
    if gone.is_empty() || bases.is_empty() {
        return Ok(checked);
    }
    // `<base> <tip>\n`, two full hashes a line.
    let mut input = String::with_capacity(gone.len() * bases.len() * 82);
    for tip in gone {
        for (base, _) in bases {
            input.push_str(base);
            input.push(' ');
            input.push_str(tip);
            input.push('\n');
        }
    }
    let overrides: Vec<String> = drivers
        .iter()
        .map(|driver| format!("{driver}=exit 1"))
        .collect();
    let mut args: Vec<&str> = Vec::with_capacity(overrides.len() * 2 + 7);
    for driver in &overrides {
        args.extend(["-c", driver.as_str()]);
    }
    args.extend([
        "-c",
        "merge.union.driver=exit 1",
        "merge-tree",
        "--stdin",
        "--name-only",
        "--no-messages",
        "--allow-unrelated-histories",
    ]);
    let scratch = match Scratch::new() {
        Ok(scratch) => scratch,
        Err(error) => {
            tracing::warn!(%error, "no folder for the merge check: every gone branch reads as not checked");
            return Ok(checked);
        }
    };
    let objects = scratch.0.to_string_lossy().into_owned();
    let alternate = alternate(&common_dir.join("objects"));
    let mut env = network_env(Prompts::Never);
    env.extend([
        ("GIT_OBJECT_DIRECTORY", objects.as_str()),
        ("GIT_ALTERNATE_OBJECT_DIRECTORIES", alternate.as_str()),
        ("GIT_NO_LAZY_FETCH", "1"),
    ]);
    let exit = run_git_env_with_input_for(root, &args, &env, input.into_bytes(), cancel, budget)?;
    let results = records(&exit.stdout);
    if results.len() < gone.len() * bases.len() {
        tracing::debug!(
            answered = results.len(),
            asked = gone.len() * bases.len(),
            status = ?exit.status,
            stderr = %exit.stderr.trim(),
            "the merge check left merges unanswered"
        );
    }
    for (tip, answers) in gone.iter().zip(results.chunks_exact(bases.len())) {
        checked.answered.insert((*tip).to_owned());
        let applied = answers
            .iter()
            .zip(bases)
            .any(|((clean, tree), (_, base_tree))| *clean && tree == base_tree);
        if applied {
            checked.applied.insert((*tip).to_owned());
        }
    }
    Ok(checked)
}

/// The merges `git merge-tree --stdin --name-only --no-messages` answered whole, in order: for
/// each, whether it was clean and its tree. Each is `<1|0>NUL<tree>NUL`, the conflicted paths
/// each ended by NUL, then an empty field; a merge whose answer was cut short is left out.
fn records(stdout: &[u8]) -> Vec<(bool, String)> {
    // Only the fields a NUL ended: the bytes after the last one are a field cut short.
    let Some(last) = stdout.iter().rposition(|byte| *byte == 0) else {
        return Vec::new();
    };
    let mut fields = stdout[..last].split(|byte| *byte == 0);
    let mut results = Vec::new();
    while let Some(status) = fields.next().filter(|status| !status.is_empty()) {
        let Some(tree) = fields.next() else {
            break;
        };
        // The conflicted paths, up to the empty field that ends the merge's answer.
        if !fields.by_ref().any(<[u8]>::is_empty) {
            break;
        }
        results.push((status == b"1", String::from_utf8_lossy(tree).into_owned()));
    }
    results
}

/// `path` as one entry of `GIT_ALTERNATE_OBJECT_DIRECTORIES`: as it is, or C-quoted when it
/// holds the list's separator or starts with a quote, as git reads such an entry.
fn alternate(path: &Path) -> String {
    let text = path.to_string_lossy();
    let separator = if cfg!(windows) { ';' } else { ':' };
    if text.contains(separator) || text.starts_with('"') {
        format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        text.into_owned()
    }
}

/// A folder of its own for the objects of a merge check, in the system's temp folder, removed
/// when dropped (again from a thread of its own while a git stopped a moment ago still holds its
/// files). A check whose process ends while git still writes leaves it behind; the first check
/// of a later process removes the ones old enough to be such leftovers.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> GitResult<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        static SWEPT: Once = Once::new();
        let temp = std::env::temp_dir();
        SWEPT.call_once(|| sweep(&temp, STALE_SCRATCH));
        new_scratch(&temp, &NEXT).map(Self).map_err(|error| {
            GitError::Git(format!(
                "no folder for the merge check in {}: {error}",
                temp.display()
            ))
        })
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
            return;
        }
        let path = self.0.clone();
        let _ = thread::Builder::new()
            .name("begitra-merge-check-cleanup".to_owned())
            .spawn(move || {
                for _ in 0..25 {
                    thread::sleep(Duration::from_millis(200));
                    if fs::remove_dir_all(&path).is_ok() || !path.exists() {
                        return;
                    }
                }
            });
    }
}

/// A folder this process makes itself in `parent`, its owner's alone; never one that is there
/// already, which on a shared `/tmp` another user could have made, with objects of their own in
/// it that git would read before the repository's.
fn new_scratch(parent: &Path, next: &AtomicU64) -> std::io::Result<PathBuf> {
    let mut taken = None;
    for _ in 0..SCRATCH_ATTEMPTS {
        let path = parent.join(format!(
            "{SCRATCH_PREFIX}{}-{}",
            std::process::id(),
            next.fetch_add(1, Ordering::Relaxed)
        ));
        match private_folder().create(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => taken = Some(error),
            Err(error) => return Err(error),
        }
    }
    Err(taken.unwrap_or_else(|| ErrorKind::AlreadyExists.into()))
}

/// A builder of one folder, never its parents, readable by its owner alone.
#[cfg(unix)]
fn private_folder() -> fs::DirBuilder {
    use std::os::unix::fs::DirBuilderExt;
    let mut builder = fs::DirBuilder::new();
    builder.mode(0o700);
    builder
}

/// A builder of one folder, never its parents (the temp folder is the user's own).
#[cfg(not(unix))]
fn private_folder() -> fs::DirBuilder {
    fs::DirBuilder::new()
}

/// Removes the merge checks' folders in `temp` last changed longer than `age` ago, as well as it
/// can: folders named as one, never a link (nor does `remove_dir_all` follow one inside).
fn sweep(temp: &Path, age: Duration) {
    let Ok(entries) = fs::read_dir(temp) else {
        return;
    };
    for entry in entries.flatten() {
        let ours = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(SCRATCH_PREFIX));
        if !ours || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|elapsed| elapsed >= age);
        if old {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// The branches git counts as in use besides the checked-out ones, as its own
/// `branch_checked_out` reads them in each worktree's git directory: the branch a rebase in
/// progress rewrites, the ones its `--update-refs` moves along, and the one a bisect started on.
fn in_use(common_dir: &Path, worktrees: &[Worktree]) -> Vec<String> {
    in_use_by(common_dir, worktrees)
        .into_iter()
        .map(|(name, _)| name)
        .collect()
}

/// [`in_use`]'s branches, each with the folder of the worktree that holds it.
pub(super) fn in_use_by(common_dir: &Path, worktrees: &[Worktree]) -> Vec<(String, PathBuf)> {
    let main = worktrees
        .iter()
        .find(|worktree| worktree.is_main)
        .map(|worktree| (common_dir.to_path_buf(), worktree.path.clone()));
    let linked = worktrees
        .iter()
        .filter(|worktree| !worktree.is_main)
        .filter_map(|worktree| {
            let name = worktree.name.as_deref()?;
            Some((
                common_dir.join("worktrees").join(name),
                worktree.path.clone(),
            ))
        });
    let mut names = Vec::new();
    for (dir, folder) in main.into_iter().chain(linked) {
        for file in ["rebase-merge/head-name", "rebase-apply/head-name"] {
            if let Ok(text) = fs::read_to_string(dir.join(file)) {
                if let Some(name) = text.trim().strip_prefix("refs/heads/") {
                    names.push((name.to_owned(), folder.clone()));
                }
            }
        }
        // Three lines a ref: its name, the commit before and the commit after.
        if let Ok(text) = fs::read_to_string(dir.join("rebase-merge/update-refs")) {
            names.extend(
                text.lines()
                    .step_by(3)
                    .filter_map(|line| line.strip_prefix("refs/heads/"))
                    .map(|name| (name.to_owned(), folder.clone())),
            );
        }
        // The branch bisect started on, by its short name (a commit when it started detached).
        if let Ok(text) = fs::read_to_string(dir.join("BISECT_START")) {
            let start = text.trim();
            if !start.is_empty() {
                names.push((
                    start
                        .strip_prefix("refs/heads/")
                        .unwrap_or(start)
                        .to_owned(),
                    folder.clone(),
                ));
            }
        }
    }
    names
}

/// The linked worktree that has `branch` checked out, when its folder is there.
fn linked_worktree_of(worktrees: &[Worktree], branch: &str, names: &Names) -> Option<PathBuf> {
    worktrees
        .iter()
        .find(|worktree| {
            !worktree.is_main
                && !worktree.prunable
                && worktree
                    .branch
                    .as_deref()
                    .is_some_and(|held| names.same(held, branch))
        })
        .map(|worktree| worktree.path.clone())
}

/// See [`crate::engine::GitEngine::delete_branches`].
#[tracing::instrument(level = "debug", skip_all, fields(branches = branches.len()))]
pub(super) fn delete_branches(
    engine: &Git2Engine,
    branches: &[BranchToDelete],
    cancel: &Cancel,
) -> GitResult<Vec<DeleteOutcome>> {
    let names = Names::of(engine)?;
    Ok(branches
        .iter()
        .map(|branch| {
            if cancel.is_cancelled() {
                kept(branch, KeptReason::Stopped, None, false)
            } else {
                delete_one(engine, branch, &names)
            }
        })
        .collect())
}

/// One branch: its tip checked, its worktree removed while it still has the branch checked out
/// (read again right before, since an earlier removal took seconds and an agent may have switched
/// it; one already gone needs nothing), its tip checked again, since the removal can take seconds
/// and an agent may commit meanwhile, then the branch deleted.
fn delete_one(engine: &Git2Engine, branch: &BranchToDelete, names: &Names) -> DeleteOutcome {
    if let Some(stays) = moved(engine, branch, false) {
        return stays;
    }
    let mut removed = false;
    if let Some(path) = branch.worktree.as_deref() {
        let worktrees = match worktrees::list(engine, &Cancel::never()) {
            Ok(worktrees) => worktrees,
            Err(error) => return kept(branch, KeptReason::Failed, Some(said(&error)), false),
        };
        match worktrees
            .iter()
            .find(|worktree| worktree_ops::same_folder(&worktree.path, path))
        {
            Some(worktree)
                if !worktree
                    .branch
                    .as_deref()
                    .is_some_and(|held| names.same(held, &branch.name)) =>
            {
                return kept(branch, KeptReason::WorktreeMoved, None, false);
            }
            Some(_) => {
                if let Err(error) = worktree_ops::remove_within(engine, path, RUN_LIMIT) {
                    // git unregisters a worktree before it deletes its folder: one whose folder it
                    // could not delete whole (a file another program holds open) is gone for git
                    // all the same, its branch kept.
                    let unregistered = worktrees::list(engine, &Cancel::never())
                        .map(|listed| {
                            !listed
                                .iter()
                                .any(|worktree| worktree_ops::same_folder(&worktree.path, path))
                        })
                        .unwrap_or(false);
                    return kept(
                        branch,
                        KeptReason::Worktree,
                        Some(said(&error)),
                        unregistered,
                    );
                }
                removed = true;
            }
            None => {}
        }
    }
    if let Some(stays) = moved(engine, branch, removed) {
        return stays;
    }
    let args = ["branch", "-D", "--", branch.name.as_str()];
    let root = &GitEngine::repo(engine).root;
    let deleted = run_git_env_within(root, &args, &WRITE_ENV, &Cancel::never(), RUN_LIMIT)
        .and_then(|exit| judged(&args, exit));
    match deleted {
        Ok(_) => DeleteOutcome {
            name: branch.name.clone(),
            deleted: true,
            reason: None,
            message: None,
            worktree_removed: removed,
        },
        Err(error) => kept(branch, KeptReason::Failed, Some(said(&error)), removed),
    }
}

/// The outcome of a branch whose tip is not the one listed any more, or that is gone; `None`
/// while it is still the one listed.
fn moved(engine: &Git2Engine, branch: &BranchToDelete, removed: bool) -> Option<DeleteOutcome> {
    let tip = engine.with_repo(|repo| {
        match repo.find_reference(&format!("refs/heads/{}", branch.name)) {
            Ok(reference) => Ok(reference.target().map(|oid| oid.to_string())),
            Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    });
    match tip {
        Ok(Some(tip)) if tip == branch.tip => None,
        Ok(Some(_)) => Some(kept(branch, KeptReason::Moved, None, removed)),
        Ok(None) => Some(kept(branch, KeptReason::Missing, None, removed)),
        Err(error) => Some(kept(
            branch,
            KeptReason::Failed,
            Some(said(&error)),
            removed,
        )),
    }
}

fn kept(
    branch: &BranchToDelete,
    reason: KeptReason,
    message: Option<String>,
    worktree_removed: bool,
) -> DeleteOutcome {
    tracing::info!(branch = %branch.name, ?reason, worktree_removed, "a branch of the cleanup stays");
    DeleteOutcome {
        name: branch.name.clone(),
        deleted: false,
        reason: Some(reason),
        message,
        worktree_removed,
    }
}

/// git's words for a failure of git, the error's own sentence otherwise.
fn said(error: &GitError) -> String {
    match error {
        GitError::Cli { stderr, .. } if !stderr.trim().is_empty() => stderr.trim().to_owned(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_each_merge_of_the_batch_with_its_conflicted_paths() {
        let tree = "a".repeat(40);
        let other = "b".repeat(40);
        let stdout = format!("1\0{tree}\0\00\0{other}\0src/a.ts\0docs/b.md\0\01\0{other}\0\0");
        assert_eq!(
            records(stdout.as_bytes()),
            [
                (true, tree.clone()),
                (false, other.clone()),
                (true, other.clone())
            ]
        );
        assert!(records(b"").is_empty());
        // Cut short by the budget: a merge's answer counts once its empty field arrived.
        let whole = format!("1\0{tree}\0\0");
        for cut in [
            format!("{whole}0"),
            format!("{whole}0\0{other}"),
            format!("{whole}0\0{other}\0"),
            format!("{whole}0\0{other}\0src/a.ts\0"),
            format!("{whole}0\0{other}\0src/a."),
        ] {
            assert_eq!(records(cut.as_bytes()), [(true, tree.clone())], "{cut:?}");
        }
        assert!(records(format!("1\0{tree}\0").as_bytes()).is_empty());
        assert!(records(format!("1\0{tree}").as_bytes()).is_empty());
    }

    #[test]
    fn checks_the_newest_tips_first_and_each_once() {
        assert_eq!(
            newest_first(vec![
                ("old", 10),
                ("new", 30),
                ("mid", 20),
                ("new", 30),
                ("same", 20)
            ]),
            ["new", "mid", "same", "old"]
        );
        assert!(newest_first(Vec::new()).is_empty());
    }

    #[test]
    fn a_tip_reads_as_checked_only_once_the_check_answered_it() {
        let checked = Checked {
            answered: HashSet::from(["a".to_owned(), "b".to_owned()]),
            applied: HashSet::from(["a".to_owned()]),
        };
        assert_eq!(checked.reason("a"), CleanupReason::GoneApplied);
        assert_eq!(checked.reason("b"), CleanupReason::Gone);
        assert_eq!(checked.reason("c"), CleanupReason::GoneUnchecked);
    }

    /// A repository with `main` and a branch `b` that adds a file main lacks: its main tip, main's
    /// tree and `b`'s tip.
    fn main_and_a_branch() -> (tempfile::TempDir, String, String, String) {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path();
        let git = |args: &[&str]| {
            let mut all = vec![
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.com",
                "-c",
                "commit.gpgsign=false",
            ];
            all.extend_from_slice(args);
            crate::cli::run_git(root, &all)
                .expect("git")
                .stdout
                .trim()
                .to_owned()
        };
        git(&["init", "-q", "-b", "main"]);
        fs::write(root.join("a.txt"), "a\n").expect("a");
        git(&["add", "."]);
        git(&["commit", "-q", "--no-verify", "-m", "a"]);
        git(&["switch", "-q", "-c", "b"]);
        fs::write(root.join("b.txt"), "b\n").expect("b");
        git(&["add", "."]);
        git(&["commit", "-q", "--no-verify", "-m", "b"]);
        let (main, tree, tip) = (
            git(&["rev-parse", "main"]),
            git(&["rev-parse", "main^{tree}"]),
            git(&["rev-parse", "b"]),
        );
        (dir, main, tree, tip)
    }

    #[test]
    fn the_merge_check_answers_within_its_budget_and_nothing_past_it() {
        let (dir, main, tree, tip) = main_and_a_branch();
        let common_dir = dir.path().join(".git");
        let bases = [(main, tree)];
        let gone = [tip.as_str()];
        let check = |budget| {
            check_merges(
                dir.path(),
                &common_dir,
                &bases,
                &[],
                &gone,
                &Cancel::never(),
                budget,
            )
            .expect("checked")
        };
        // `b` brings a file main lacks: answered, not applied.
        assert_eq!(
            check(Duration::from_secs(60)).reason(&tip),
            CleanupReason::Gone
        );
        // No time at all: git is stopped before it answers.
        assert_eq!(
            check(Duration::ZERO).reason(&tip),
            CleanupReason::GoneUnchecked
        );
    }

    #[test]
    fn a_merge_check_never_takes_a_folder_it_did_not_make() {
        let parent = tempfile::tempdir().expect("temp dir");
        let next = AtomicU64::new(0);
        // Someone else's folder under the first name, with a file of theirs in it.
        let theirs = parent
            .path()
            .join(format!("{SCRATCH_PREFIX}{}-0", std::process::id()));
        fs::create_dir(&theirs).expect("their folder");
        fs::write(theirs.join("planted"), "x").expect("planted");
        let made = new_scratch(parent.path(), &next).expect("a folder of its own");
        assert_ne!(made, theirs);
        assert_eq!(fs::read_dir(&made).expect("made").count(), 0);
        assert!(theirs.join("planted").exists());
        // A parent where no folder can be made answers the error.
        let file = parent.path().join("not-a-folder");
        fs::write(&file, "").expect("file");
        assert!(new_scratch(&file, &next).is_err());
    }

    #[test]
    fn names_compare_as_the_disk_does() {
        let exact = Names { ignore_case: false };
        assert!(!exact.same("Feature", "feature"));
        assert_eq!(exact.key("Feature"), "Feature");
        let folded = Names { ignore_case: true };
        assert!(folded.same("Feature/Árbol", "feature/árbol"));
        assert_eq!(folded.key("Feature/Árbol"), "feature/árbol");
        assert!(!folded.same("feature", "features"));
    }

    #[test]
    fn quotes_an_alternate_only_when_git_would_split_it() {
        assert_eq!(
            alternate(Path::new("C:/code/r/.git/objects")).contains('"'),
            cfg!(not(windows))
        );
        let separator = if cfg!(windows) { ';' } else { ':' };
        let odd = format!("/x{separator}y\\z/objects");
        assert_eq!(
            alternate(Path::new(&odd)),
            format!("\"/x{separator}y\\\\z/objects\"")
        );
        assert_eq!(alternate(Path::new("/plain/objects")), "/plain/objects");
    }

    #[test]
    fn sweeps_the_folders_old_enough_to_be_leftovers() {
        let temp = tempfile::tempdir().expect("temp dir");
        let left = temp.path().join(format!("{SCRATCH_PREFIX}1-0"));
        fs::create_dir_all(left.join("ab")).expect("left over");
        fs::write(left.join("ab/cdef"), "object").expect("object");
        // What is not a merge check's folder stays, whatever its age.
        let other = temp.path().join("other-program");
        fs::create_dir(&other).expect("other");
        let named = temp.path().join(format!("{SCRATCH_PREFIX}file"));
        fs::write(&named, "").expect("file");
        sweep(temp.path(), Duration::from_secs(3600));
        assert!(left.exists(), "a recent folder may be a check at work");
        sweep(temp.path(), Duration::ZERO);
        assert!(!left.exists());
        assert!(other.exists() && named.exists());
        // A temp folder that is not there sweeps nothing.
        sweep(&temp.path().join("missing"), Duration::ZERO);
    }
}
