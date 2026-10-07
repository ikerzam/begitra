//! `GitEngine::refs` against `git for-each-ref`, `git stash list`, `git rev-list --left-right`
//! and `git branch --format=%(worktreepath)`.

mod support;

use std::path::{Path, PathBuf};

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{Ref, RefKind};
use support::{canonical, Fixture};

fn refs_at(path: &Path) -> Vec<Ref> {
    Git2Engine::open(path)
        .expect("open")
        .refs(&Cancel::never())
        .expect("refs")
}

fn find<'a>(refs: &'a [Ref], full_name: &str) -> &'a Ref {
    refs.iter()
        .find(|r| r.full_name == full_name)
        .unwrap_or_else(|| panic!("{full_name} missing from {refs:#?}"))
}

/// Paths compare canonically when the folder exists and textually when it is gone.
fn assert_same_path(actual: &Path, expected: &Path) {
    if expected.exists() && actual.exists() {
        assert_eq!(canonical(actual), canonical(expected));
    } else {
        assert_eq!(
            actual.components().collect::<PathBuf>(),
            expected.components().collect::<PathBuf>()
        );
    }
}

/// `git for-each-ref` entries of the kinds the engine lists (local branches, remote branches
/// without the remote HEAD, tags) as `(refname, commit)`, in git's order. Annotated tags are
/// peeled like `%(*objectname)`.
fn cli_refs(f: &Fixture) -> Vec<(String, String)> {
    f.git(&[
        "for-each-ref",
        "--format=%(refname) %(objectname) %(*objectname)",
    ])
    .lines()
    .filter_map(|line| {
        let mut parts = line.split(' ');
        let name = parts.next().unwrap_or_default().to_owned();
        let object = parts.next().unwrap_or_default();
        let peeled = parts.next().unwrap_or_default();
        let listed = name.starts_with("refs/heads/")
            || name.starts_with("refs/tags/")
            || (name.starts_with("refs/remotes/") && !name.ends_with("/HEAD"));
        let target = if peeled.is_empty() { object } else { peeled };
        listed.then(|| (name, target.to_owned()))
    })
    .collect()
}

fn rank(kind: RefKind) -> u8 {
    match kind {
        RefKind::LocalBranch => 0,
        RefKind::RemoteBranch => 1,
        RefKind::Tag => 2,
        RefKind::Stash => 3,
        RefKind::Head => 4,
    }
}

#[test]
fn lists_branches_remotes_tags_stashes_and_head_like_the_cli() {
    let mut f = Fixture::basic().with_remote().with_stash();
    // The remote HEAD is symbolic and must be skipped; the extra branches check byte order.
    f.git(&["remote", "set-head", "origin", "main"]);
    f.git(&["branch", "-q", "Zed"]);
    f.git(&["branch", "-q", "feature-x"]);
    f.git(&["branch", "-q", "feature/y"]);
    f.append("README.md", "second stash\n");
    f.tick();
    f.git(&["stash", "push", "-q", "-m", "wip: second"]);

    let refs = refs_at(&f.root);

    let listed: Vec<(String, String)> = refs
        .iter()
        .filter(|r| !matches!(r.kind, RefKind::Stash | RefKind::Head))
        .map(|r| (r.full_name.clone(), r.target.clone()))
        .collect();
    assert_eq!(listed, cli_refs(&f));
    assert!(f
        .git(&["for-each-ref"])
        .contains("refs/remotes/origin/HEAD"));
    assert!(refs
        .iter()
        .all(|r| r.full_name != "refs/remotes/origin/HEAD"));

    let kinds: Vec<RefKind> = refs.iter().map(|r| r.kind).collect();
    assert!(
        kinds.windows(2).all(|w| rank(w[0]) <= rank(w[1])),
        "{kinds:?}"
    );
    for r in &refs {
        let expected = if r.full_name.starts_with("refs/heads/") {
            RefKind::LocalBranch
        } else if r.full_name.starts_with("refs/remotes/") {
            RefKind::RemoteBranch
        } else if r.full_name.starts_with("refs/tags/") {
            RefKind::Tag
        } else if r.full_name == "refs/stash" {
            RefKind::Stash
        } else {
            RefKind::Head
        };
        assert_eq!(r.kind, expected, "{r:?}");
    }
    assert_eq!(find(&refs, "refs/heads/main").name, "main");
    assert_eq!(find(&refs, "refs/heads/feature/y").name, "feature/y");
    assert_eq!(
        find(&refs, "refs/remotes/origin/develop").name,
        "origin/develop"
    );
    assert_eq!(find(&refs, "refs/tags/v1").name, "v1");

    let stashes: Vec<&Ref> = refs.iter().filter(|r| r.kind == RefKind::Stash).collect();
    let cli_hashes = f.git(&["stash", "list", "--format=%H"]);
    assert_eq!(
        stashes
            .iter()
            .map(|r| r.target.as_str())
            .collect::<Vec<_>>(),
        cli_hashes.lines().collect::<Vec<_>>()
    );
    assert_eq!(
        stashes.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
        ["stash@{0}", "stash@{1}"]
    );
    assert!(stashes.iter().all(|r| r.full_name == "refs/stash"));
    let cli_messages = f.git(&["stash", "list", "--format=%gs"]);
    assert_eq!(
        stashes
            .iter()
            .map(|r| r.message.clone().unwrap_or_default())
            .collect::<Vec<_>>(),
        cli_messages.lines().collect::<Vec<_>>()
    );
    assert_eq!(stashes[0].message.as_deref(), Some("On main: wip: second"));

    let head = refs.last().expect("HEAD");
    assert_eq!(head.kind, RefKind::Head);
    assert_eq!(
        (head.name.as_str(), head.full_name.as_str()),
        ("HEAD", "HEAD")
    );
    assert_eq!(head.target, f.head());
    assert!(head.is_current);

    let current: Vec<&str> = refs
        .iter()
        .filter(|r| r.is_current)
        .map(|r| r.full_name.as_str())
        .collect();
    assert_eq!(current, ["refs/heads/main", "HEAD"]);
}

#[test]
fn reports_ahead_and_behind_like_rev_list() {
    let f = Fixture::basic().with_remote();
    let refs = refs_at(&f.root);

    let develop = find(&refs, "refs/heads/develop");
    assert_eq!(develop.upstream.as_deref(), Some("origin/develop"));
    assert_eq!((develop.ahead, develop.behind), (Some(2), Some(3)));
    let counts = f.git(&[
        "rev-list",
        "--left-right",
        "--count",
        "develop...origin/develop",
    ]);
    assert_eq!(
        counts,
        format!("{}\t{}", develop.ahead.unwrap(), develop.behind.unwrap())
    );

    let main = find(&refs, "refs/heads/main");
    assert_eq!(main.upstream.as_deref(), Some("origin/main"));
    assert_eq!((main.ahead, main.behind), (Some(0), Some(0)));

    let remote = find(&refs, "refs/remotes/origin/develop");
    assert_eq!(
        (remote.upstream.as_deref(), remote.ahead, remote.behind),
        (None, None, None)
    );
}

#[test]
fn a_branch_without_upstream_has_no_counts() {
    let f = Fixture::basic();
    let refs = refs_at(&f.root);
    let develop = find(&refs, "refs/heads/develop");
    assert_eq!(
        (develop.upstream.as_deref(), develop.ahead, develop.behind),
        (None, None, None)
    );
}

#[test]
fn a_branch_whose_remote_is_a_url_lists_without_an_upstream() {
    let f = Fixture::basic();
    f.git(&["branch", "-q", "fork-pr", "develop"]);
    f.git(&[
        "config",
        "branch.fork-pr.remote",
        "https://example.invalid/someone/fork.git",
    ]);
    f.git(&["config", "branch.fork-pr.merge", "refs/heads/fix"]);
    let shown = f.git(&[
        "for-each-ref",
        "--format=%(upstream:short)",
        "refs/heads/fork-pr",
    ]);
    assert_eq!(shown, "");
    let refs = refs_at(&f.root);
    let branch = find(&refs, "refs/heads/fork-pr");
    assert_eq!(
        (branch.upstream.as_deref(), branch.ahead, branch.behind),
        (None, None, None)
    );
}

#[test]
fn a_gone_upstream_keeps_its_name_without_counts() {
    let f = Fixture::basic().with_remote();
    f.git(&["branch", "-q", "--track", "topic", "origin/develop"]);
    f.git(&["update-ref", "-d", "refs/remotes/origin/develop"]);
    let track = f.git(&[
        "branch",
        "--list",
        "--format=%(upstream:short) %(upstream:track)",
        "topic",
    ]);
    assert_eq!(track, "origin/develop [gone]");

    let refs = refs_at(&f.root);
    let topic = find(&refs, "refs/heads/topic");
    assert_eq!(topic.upstream.as_deref(), Some("origin/develop"));
    assert_eq!((topic.ahead, topic.behind), (None, None));
}

/// Each branch's upstream is the one `git for-each-ref --format=%(upstream:short)` shows,
/// however its remote maps the merge ref: a local upstream (remote `.`), a fetch refspec of
/// another shape, a negative refspec that would exclude the ref (git's upstream ignores it),
/// a remote that does not exist, a merge ref no refspec takes; a configuration section of a
/// deleted branch changes nothing.
#[test]
fn upstreams_follow_each_remote_s_refspecs_like_git() {
    let f = Fixture::basic().with_remote();
    f.git(&["remote", "add", "fork", "https://example.invalid/fork.git"]);
    f.git(&[
        "config",
        "--replace-all",
        "remote.fork.fetch",
        "+refs/heads/*:refs/remotes/mirror/fork/*",
    ]);
    f.git(&[
        "config",
        "--add",
        "remote.origin.fetch",
        "^refs/heads/wip/*",
    ]);
    let tip = f.git(&["rev-parse", "develop"]);
    f.git(&["update-ref", "refs/remotes/mirror/fork/feature", &tip]);
    f.git(&["update-ref", "refs/remotes/origin/wip/x", &tip]);
    let setups = [
        ("local", ".", "refs/heads/develop"),
        ("forked", "fork", "refs/heads/feature"),
        ("excluded", "origin", "refs/heads/wip/x"),
        ("unknown-remote", "nowhere", "refs/heads/main"),
        ("untaken", "fork", "refs/tags/v1"),
        ("tracked", "origin", "refs/heads/develop"),
    ];
    for (name, remote, merge) in setups {
        f.git(&["branch", "-q", name, "main"]);
        f.git(&["config", &format!("branch.{name}.remote"), remote]);
        f.git(&["config", &format!("branch.{name}.merge"), merge]);
    }
    f.git(&["config", "branch.deleted.remote", "origin"]);
    f.git(&["config", "branch.deleted.merge", "refs/heads/main"]);
    let refs = refs_at(&f.root);
    let mut shown_any = 0;
    for (name, _, _) in setups {
        let full_name = format!("refs/heads/{name}");
        let shown = f.git(&["for-each-ref", "--format=%(upstream:short)", &full_name]);
        let listed = find(&refs, &full_name);
        assert_eq!(listed.upstream.as_deref().unwrap_or(""), shown, "{name}");
        if !shown.is_empty() {
            shown_any += 1;
            let counts = f.git(&[
                "rev-list",
                "--left-right",
                "--count",
                &format!("{name}...{shown}"),
            ]);
            assert_eq!(
                counts,
                format!("{}\t{}", listed.ahead.unwrap(), listed.behind.unwrap()),
                "{name}"
            );
        }
    }
    assert_eq!(shown_any, 4, "local, forked, excluded and tracked have one");
}

#[test]
fn carries_the_committer_time_of_each_ref_s_commit_like_log() {
    let mut f = Fixture::basic().with_remote().with_stash();
    f.git(&["tag", "light", "develop"]);
    f.git(&["tag", "tree", "HEAD^{tree}"]);
    f.git(&["tag", "-a", "tree-note", "-m", "a tree", "HEAD^{tree}"]);
    f.git(&["checkout", "-q", "-b", "fresh"]);
    f.write("fresh.txt", "fresh\n");
    f.commit("f1: fresh");
    f.git(&["checkout", "-q", "main"]);
    let refs = refs_at(&f.root);

    // (listed ref, what git log reads it as); the annotated tag v1 is its tagged commit's.
    for (full_name, spec) in [
        ("refs/heads/main", "main"),
        ("refs/heads/develop", "develop"),
        ("refs/heads/fresh", "fresh"),
        ("refs/remotes/origin/main", "origin/main"),
        ("refs/remotes/origin/develop", "origin/develop"),
        ("refs/tags/v1", "v1"),
        ("refs/tags/light", "light"),
        ("refs/stash", "stash@{0}"),
        ("HEAD", "HEAD"),
    ] {
        let expected: i64 = f
            .git(&["log", "-1", "--format=%ct", spec])
            .trim()
            .parse()
            .expect("a Unix time");
        assert_eq!(
            find(&refs, full_name).committed_at,
            Some(expected),
            "{full_name}"
        );
    }
    let fresh = find(&refs, "refs/heads/fresh").committed_at;
    assert!(fresh > find(&refs, "refs/heads/main").committed_at);
    assert!(find(&refs, "refs/tags/v1").committed_at < fresh);
    // A tag of a tree, lightweight or annotated, has no commit and so no time.
    assert_eq!(find(&refs, "refs/tags/tree").committed_at, None);
    assert_eq!(find(&refs, "refs/tags/tree-note").committed_at, None);
}

#[test]
fn takes_the_committer_time_rather_than_the_author_s_or_the_tagger_s() {
    let mut f = Fixture::basic();
    // An amend keeps the author time and takes the clock as the committer time.
    f.tick();
    f.git(&["commit", "--amend", "--no-edit", "-q"]);
    // A tag made after its commit: the tagger time is the clock.
    f.tick();
    f.git(&["tag", "-a", "late", "-m", "late", "HEAD~1"]);
    let refs = refs_at(&f.root);
    let time = |args: &[&str]| -> i64 { f.git(args).parse().expect("a Unix time") };

    let author = time(&["log", "-1", "--format=%at", "main"]);
    let committer = time(&["log", "-1", "--format=%ct", "main"]);
    assert_ne!(author, committer);
    assert_eq!(find(&refs, "refs/heads/main").committed_at, Some(committer));

    let tagged = time(&["log", "-1", "--format=%ct", "late"]);
    let tagger = time(&[
        "for-each-ref",
        "--format=%(taggerdate:unix)",
        "refs/tags/late",
    ]);
    assert_ne!(tagged, tagger);
    assert_eq!(find(&refs, "refs/tags/late").committed_at, Some(tagged));
}

/// The instant, not the wall clock: commits made in zones nineteen hours apart carry the Unix
/// seconds `git log --format=%ct` prints, and the later instant comes out later even though its
/// local time is earlier.
#[test]
fn committer_times_are_instants_whatever_the_zone() {
    let f = Fixture::basic();
    for (branch, date) in [
        ("east", "2026-03-10T12:00:00+1400"),
        ("west", "2026-03-10T08:00:00-0500"),
    ] {
        f.git(&["checkout", "-q", "-b", branch, "main"]);
        f.write(&format!("{branch}.txt"), branch);
        f.git(&["add", "-A"]);
        f.git_with_env(
            &[("GIT_AUTHOR_DATE", date), ("GIT_COMMITTER_DATE", date)],
            &["commit", "-q", "-m", branch],
        );
    }
    f.git(&["checkout", "-q", "main"]);
    let refs = refs_at(&f.root);
    let at = |branch: &str| find(&refs, &format!("refs/heads/{branch}")).committed_at;

    // 2026-03-09T22:00:00Z and 2026-03-10T13:00:00Z.
    assert_eq!(at("east"), Some(1_773_093_600));
    assert_eq!(at("west"), Some(1_773_147_600));
    for branch in ["east", "west"] {
        let expected: i64 = f
            .git(&["log", "-1", "--format=%ct", branch])
            .parse()
            .expect("a Unix time");
        assert_eq!(at(branch), Some(expected), "{branch}");
    }
    assert!(at("west") > at("east"));
}

#[test]
fn peels_annotated_tags_and_carries_their_message() {
    let f = Fixture::basic();
    f.git(&["tag", "light", "HEAD~1"]);
    f.git(&["tag", "-a", "v2", "-m", "line one", "-m", "line two"]);
    let refs = refs_at(&f.root);

    let v1 = find(&refs, "refs/tags/v1");
    assert_eq!(v1.target, f.rev("v1^{commit}"));
    assert_ne!(
        v1.target,
        f.rev("v1"),
        "the tag object itself is not the target"
    );
    let listed = f.git(&["tag", "-n1", "--list", "v1"]);
    assert_eq!(listed.strip_prefix("v1").map(str::trim), Some("version 1"));
    assert_eq!(v1.message.as_deref(), Some("version 1"));

    let v2 = find(&refs, "refs/tags/v2");
    assert_eq!(v2.message.as_deref(), Some("line one\n\nline two"));
    assert_eq!(
        v2.message.as_deref().unwrap_or_default(),
        f.git(&["for-each-ref", "--format=%(contents)", "refs/tags/v2"])
    );

    let light = find(&refs, "refs/tags/light");
    assert_eq!(light.target, f.rev("HEAD~1"));
    assert_eq!(light.message, None);
}

#[test]
fn marks_branches_checked_out_in_worktrees_like_the_cli() {
    let f = Fixture::basic()
        .with_linked_worktree()
        .with_broken_worktrees();
    let refs = refs_at(&f.root);
    let cli = f.git(&["branch", "--list", "--format=%(refname)%09%(worktreepath)"]);
    let mut checked_out = 0;
    for line in cli.lines() {
        let (name, path) = line.split_once('\t').unwrap_or((line, ""));
        let r = find(&refs, name);
        match (&r.worktree, path) {
            (None, "") => {}
            (Some(actual), expected) if !expected.is_empty() => {
                assert_same_path(actual, Path::new(expected));
                checked_out += 1;
            }
            other => panic!("{name}: {other:?}"),
        }
    }
    assert_eq!(checked_out, 4, "main, feature/wt, gone and locked: {cli}");
    assert_eq!(find(&refs, "refs/heads/develop").worktree, None);
    assert!(find(&refs, "refs/heads/gone")
        .worktree
        .as_ref()
        .is_some_and(|p| p.ends_with("wt-gone")));
    assert!(refs
        .iter()
        .filter(|r| r.kind != RefKind::LocalBranch)
        .all(|r| r.worktree.is_none()));
}

#[test]
fn is_current_follows_the_opened_worktree() {
    let f = Fixture::basic().with_linked_worktree();
    let refs = refs_at(&f.worktree_path());
    assert!(find(&refs, "refs/heads/feature/wt").is_current);
    assert!(!find(&refs, "refs/heads/main").is_current);
    let head = refs.last().expect("HEAD");
    assert_eq!(head.kind, RefKind::Head);
    assert_eq!(head.target, f.rev("feature/wt"));
    let main = find(&refs, "refs/heads/main");
    assert_same_path(
        main.worktree.as_deref().expect("main is checked out"),
        &f.root,
    );
    assert_same_path(
        find(&refs, "refs/heads/feature/wt")
            .worktree
            .as_deref()
            .expect("feature/wt is checked out"),
        &f.worktree_path(),
    );
}

#[test]
fn a_detached_head_is_listed_without_a_current_branch() {
    let f = Fixture::basic();
    f.git(&["checkout", "-q", "HEAD~1"]);
    let refs = refs_at(&f.root);
    assert!(refs
        .iter()
        .filter(|r| r.kind != RefKind::Head)
        .all(|r| !r.is_current));
    let head = refs.last().expect("HEAD");
    assert_eq!(head.kind, RefKind::Head);
    assert!(head.is_current);
    assert_eq!(head.target, f.head());
    assert!(refs
        .iter()
        .filter(|r| r.kind == RefKind::LocalBranch)
        .all(|r| r.worktree.is_none()));
}

#[test]
fn an_unborn_repository_lists_nothing() {
    let f = Fixture::unborn();
    assert!(refs_at(&f.root).is_empty());
}

#[test]
fn a_corrupt_target_reports_its_hash() {
    let f = Fixture::basic();
    let hash = f.truncate_object("develop");
    let engine = Git2Engine::open(&f.root).expect("open");
    let error = engine.refs(&Cancel::never()).expect_err("must fail");
    assert_eq!(error.code(), "repo.corrupt_object");
    match &error {
        GitError::CorruptObject { hash: reported, .. } => assert_eq!(reported, &hash),
        other => panic!("unexpected error {other:?}"),
    }
}

#[test]
fn stops_when_cancelled() {
    let f = Fixture::basic();
    let engine = Git2Engine::open(&f.root).expect("open");
    let cancel = Cancel::new();
    cancel.cancel();
    let error = engine.refs(&cancel).expect_err("must be cancelled");
    assert!(matches!(error, GitError::Cancelled), "{error:?}");
    assert_eq!(error.code(), "op.cancelled");
}

/// With many tracking branches the counts are computed on several threads; every branch must
/// still carry what `git rev-list --left-right --count` reports.
#[test]
fn many_tracking_branches_report_the_same_counts_as_rev_list() {
    let f = Fixture::basic().with_remote();
    for n in 0..24 {
        let name = format!("t{n:02}");
        let (start, upstream) = match n % 4 {
            0 => ("develop", "origin/develop"),
            1 => ("origin/develop", "origin/develop"),
            2 => ("main~1", "origin/main"),
            _ => ("main", "origin/develop"),
        };
        f.git(&["branch", "-q", &name, start]);
        f.git(&["branch", "-q", "--set-upstream-to", upstream, &name]);
    }
    let refs = refs_at(&f.root);
    let tracking: Vec<&Ref> = refs
        .iter()
        .filter(|r| r.kind == RefKind::LocalBranch && r.upstream.is_some())
        .collect();
    assert!(tracking.len() >= 24, "{} tracking branches", tracking.len());
    for branch in tracking {
        let upstream = branch.upstream.as_deref().unwrap_or_default();
        let range = format!("{}...{upstream}", branch.name);
        let counts = f.git(&["rev-list", "--left-right", "--count", &range]);
        assert_eq!(
            counts,
            format!("{}\t{}", branch.ahead.unwrap(), branch.behind.unwrap()),
            "{}",
            branch.name
        );
    }
}

/// Many local branches without an upstream stay on the inline path: no counts, no threads,
/// and the tracking branches among them still get their counts.
#[test]
fn branches_without_upstream_have_no_counts_however_many_there_are() {
    let f = Fixture::basic().with_remote();
    for n in 0..40 {
        f.git(&["branch", "-q", &format!("plain-{n:02}"), "main"]);
    }
    let refs = refs_at(&f.root);
    let plain: Vec<&Ref> = refs
        .iter()
        .filter(|r| r.name.starts_with("plain-"))
        .collect();
    assert_eq!(plain.len(), 40);
    assert!(plain
        .iter()
        .all(|r| r.upstream.is_none() && r.ahead.is_none() && r.behind.is_none()));
    let develop = find(&refs, "refs/heads/develop");
    assert_eq!((develop.ahead, develop.behind), (Some(2), Some(3)));
}

/// A ref whose object is gone (an interrupted fetch, a prune) is skipped with a warning, as
/// `git branch -a` does; the rest of the listing is intact. A truncated object stays an error.
#[test]
fn a_broken_ref_is_skipped_like_git() {
    let mut f = Fixture::basic();
    f.git(&["checkout", "-q", "-b", "broken"]);
    f.write(
        "broken.txt",
        "x
",
    );
    f.commit("only on broken");
    f.git(&["checkout", "-q", "main"]);
    f.delete_object("broken");
    let engine = Git2Engine::open(&f.root).expect("open");
    let refs = engine.refs(&Cancel::never()).expect("listing goes on");
    assert!(refs.iter().all(|r| r.name != "broken"));
    assert!(refs.iter().any(|r| r.name == "develop"));
    let cli = f.git(&["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    assert!(cli.lines().any(|line| line == "develop"));
}
