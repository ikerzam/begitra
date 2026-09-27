//! `Git2Engine` remotes, fetch, pull and push against a local bare remote.

mod support;

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use git_core::cli::failing_askpass;
use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{OutcomeKind, Prompts, PullRequest, PushRequest};
use support::Fixture;

fn engine(f: &Fixture) -> Git2Engine {
    Git2Engine::open(&f.root).expect("open fixture")
}

fn never() -> Cancel {
    Cancel::never()
}

/// A progress sink that keeps every line.
fn sink() -> (Arc<Mutex<Vec<String>>>, impl FnMut(&str)) {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let writer = Arc::clone(&lines);
    (lines, move |line: &str| {
        if let Ok(mut lines) = writer.lock() {
            lines.push(line.to_owned());
        }
    })
}

fn origin_rev(f: &Fixture, rev: &str) -> String {
    let origin = f.sibling("origin.git");
    f.git_in(&origin, &["rev-parse", rev])
}

#[test]
fn lists_adds_and_removes_remotes() {
    let f = Fixture::basic().with_remote();
    let e = engine(&f);
    let remotes = e.remotes(&never()).expect("remotes");
    assert_eq!(remotes.len(), 1);
    assert_eq!(remotes[0].name, "origin");
    assert!(
        remotes[0].fetch_url.ends_with("origin.git"),
        "{}",
        remotes[0].fetch_url
    );
    assert_eq!(remotes[0].fetch_url, remotes[0].push_url);
    // The fixture pushed to origin but never fetched: no fetch time yet.
    assert_eq!(remotes[0].fetched_at, None);
    let second = f.sibling("second.git");
    f.git(&["init", "-q", "--bare", second.to_str().expect("utf-8")]);
    e.remote_add("second", second.to_str().expect("utf-8"), &never())
        .expect("add");
    let remotes = e.remotes(&never()).expect("remotes");
    assert_eq!(
        remotes.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
        ["origin", "second"]
    );
    // A fetch of origin dates origin (FETCH_HEAD's time) and leaves second undated.
    e.fetch(
        Some("origin"),
        false,
        Prompts::Allowed,
        &mut |_| {},
        &never(),
    )
    .expect("fetch");
    let remotes = e.remotes(&never()).expect("remotes");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(0))
        .unwrap_or(0);
    let fetched = remotes[0].fetched_at.expect("origin was fetched");
    assert!((now - fetched).abs() < 120, "{fetched} vs {now}");
    assert_eq!(remotes[1].fetched_at, None);
    e.remote_remove("second", &never()).expect("remove");
    assert_eq!(e.remotes(&never()).expect("remotes").len(), 1);
    let error = e
        .remote_add("origin", "x", &never())
        .expect_err("exists already");
    assert!(matches!(error, GitError::Cli { .. }));
}

#[test]
fn pushes_with_progress_and_the_remote_follows() {
    let mut f = Fixture::basic().with_remote();
    let e = engine(&f);
    f.write("pushed.txt", "p\n");
    let tip = f.commit("to push");
    let (lines, mut progress) = sink();
    let result = e
        .push(
            &PushRequest {
                remote: Some("origin".to_owned()),
                branch: Some("main".to_owned()),
                set_upstream: false,
                force_with_lease: false,
            },
            Prompts::Allowed,
            &mut progress,
            &never(),
        )
        .expect("push");
    assert_eq!(origin_rev(&f, "main"), tip);
    let lines = lines.lock().expect("lines").clone();
    assert!(
        lines
            .iter()
            .any(|l| l.starts_with("Writing objects") || l.starts_with("Enumerating")),
        "{lines:?}"
    );
    assert!(
        result.summary.iter().any(|l| l.contains("main -> main")),
        "{:?}",
        result.summary
    );
}

#[test]
fn a_rejected_push_and_a_lease_force() {
    let mut f = Fixture::basic().with_remote();
    let e = engine(&f);
    // The remote's develop is 3 ahead of the local one (with_remote): a push is rejected.
    let error = e
        .push(
            &PushRequest {
                remote: Some("origin".to_owned()),
                branch: Some("develop".to_owned()),
                set_upstream: false,
                force_with_lease: false,
            },
            Prompts::Allowed,
            &mut |_| {},
            &never(),
        )
        .expect_err("rejected");
    match error {
        GitError::Cli { stderr, .. } => assert!(stderr.contains("rejected"), "{stderr}"),
        other => panic!("unexpected {other:?}"),
    }
    // With a lease the push is accepted only when the tracking ref is current: fetch first.
    e.fetch(
        Some("origin"),
        false,
        Prompts::Allowed,
        &mut |_| {},
        &never(),
    )
    .expect("fetch");
    let local = f.rev("develop");
    e.push(
        &PushRequest {
            remote: Some("origin".to_owned()),
            branch: Some("develop".to_owned()),
            set_upstream: false,
            force_with_lease: true,
        },
        Prompts::Allowed,
        &mut |_| {},
        &never(),
    )
    .expect("forced with lease");
    assert_eq!(origin_rev(&f, "develop"), local);
    f.tick();
}

#[test]
fn push_with_set_upstream_records_the_tracking() {
    let mut f = Fixture::basic().with_remote();
    let e = engine(&f);
    f.git(&["switch", "-q", "-c", "topic"]);
    f.write("t.txt", "t\n");
    f.commit("topic");
    e.push(
        &PushRequest {
            remote: Some("origin".to_owned()),
            branch: Some("topic".to_owned()),
            set_upstream: true,
            force_with_lease: false,
        },
        Prompts::Allowed,
        &mut |_| {},
        &never(),
    )
    .expect("push -u");
    assert_eq!(
        f.git(&["rev-parse", "--abbrev-ref", "topic@{upstream}"]),
        "origin/topic"
    );
}

#[test]
fn fetches_with_prune_and_pulls_with_and_without_rebase() {
    let mut f = Fixture::basic().with_remote();
    let e = engine(&f);
    let origin = f.sibling("origin.git");
    // A branch that exists on the remote only, then deleted there: prune removes the ref.
    f.git_in(&origin, &["branch", "gone", "main"]);
    e.fetch(
        Some("origin"),
        false,
        Prompts::Allowed,
        &mut |_| {},
        &never(),
    )
    .expect("fetch");
    assert!(f.try_git(&["rev-parse", "--verify", "origin/gone"]).0);
    f.git_in(&origin, &["branch", "-D", "gone"]);
    e.fetch(
        Some("origin"),
        true,
        Prompts::Allowed,
        &mut |_| {},
        &never(),
    )
    .expect("fetch --prune");
    assert!(!f.try_git(&["rev-parse", "--verify", "origin/gone"]).0);
    // develop is behind origin/develop by 3 and ahead by 2 (with_remote): a pull merges.
    f.git(&["switch", "-q", "develop"]);
    let outcome = e
        .pull(
            &PullRequest {
                remote: Some("origin".to_owned()),
                branch: Some("develop".to_owned()),
                rebase: false,
                ff_only: false,
            },
            Prompts::Allowed,
            &mut |_| {},
            &never(),
        )
        .expect("pull");
    assert_eq!(outcome.kind, OutcomeKind::Merged);
    assert_eq!(
        f.git(&["rev-list", "--count", "origin/develop..develop"]),
        "3"
    );
    // Back to the diverged state and pull with rebase: the local commits replay on top.
    f.git(&["reset", "-q", "--hard", "ORIG_HEAD"]);
    let outcome = e
        .pull(
            &PullRequest {
                remote: Some("origin".to_owned()),
                branch: Some("develop".to_owned()),
                rebase: true,
                ff_only: false,
            },
            Prompts::Allowed,
            &mut |_| {},
            &never(),
        )
        .expect("pull --rebase");
    assert_eq!(outcome.kind, OutcomeKind::Done);
    assert_eq!(
        f.git(&["rev-list", "--count", "origin/develop..develop"]),
        "2"
    );
    assert_eq!(
        f.git(&["merge-base", "origin/develop", "develop"]),
        f.rev("origin/develop")
    );
    f.tick();
}

#[test]
fn a_cancel_stops_a_push() {
    // The flag is set before the run: the push never starts (the runner's mid-run cancel,
    // which kills git's tree, is covered in `cli.rs`).
    let f = Fixture::basic().with_remote();
    let e = engine(&f);
    let cancel = Cancel::new();
    cancel.cancel();
    let error = e
        .push(
            &PushRequest {
                remote: Some("origin".to_owned()),
                branch: Some("main".to_owned()),
                set_upstream: false,
                force_with_lease: false,
            },
            Prompts::Allowed,
            &mut |_| {},
            &cancel,
        )
        .expect_err("cancelled");
    assert!(matches!(error, GitError::Cancelled), "{error:?}");
}

#[test]
fn a_pull_tells_a_fast_forward_from_a_merge_and_says_up_to_date() {
    let mut f = Fixture::basic().with_remote();
    let e = engine(&f);
    // main's tip on origin is m1, a merge commit; local main one behind: a pull fast-forwards
    // onto it (a merge commit as the tip is not a merge the pull made).
    let tip = f.rev("main");
    f.git(&["reset", "-q", "--hard", "main~1"]);
    let request = PullRequest {
        remote: Some("origin".to_owned()),
        branch: Some("main".to_owned()),
        rebase: false,
        ff_only: false,
    };
    let outcome = e
        .pull(&request, Prompts::Allowed, &mut |_| {}, &never())
        .expect("pull");
    assert_eq!(outcome.kind, OutcomeKind::FastForward);
    assert_eq!(f.head(), tip);
    assert_eq!(outcome.hash.as_deref(), Some(tip.as_str()));
    // Again: nothing to do, with and without rebase.
    let outcome = e
        .pull(&request, Prompts::Allowed, &mut |_| {}, &never())
        .expect("pull");
    assert_eq!(outcome.kind, OutcomeKind::UpToDate);
    let outcome = e
        .pull(
            &PullRequest {
                rebase: true,
                ..request.clone()
            },
            Prompts::Allowed,
            &mut |_| {},
            &never(),
        )
        .expect("pull --rebase");
    assert_eq!(outcome.kind, OutcomeKind::UpToDate);
    assert_eq!(f.head(), tip);
    // The reflog names the pull, as `git pull` does.
    assert!(
        f.git(&["reflog", "-1", "--format=%gs"]).starts_with("pull"),
        "{}",
        f.git(&["reflog", "-3", "--format=%gs"])
    );
    // `pull.ff=only` is the user's: a diverged branch is refused, not merged.
    f.git(&["switch", "-q", "develop"]);
    f.git(&["config", "pull.ff", "only"]);
    let error = e
        .pull(
            &PullRequest {
                remote: Some("origin".to_owned()),
                branch: Some("develop".to_owned()),
                rebase: false,
                ff_only: false,
            },
            Prompts::Allowed,
            &mut |_| {},
            &never(),
        )
        .expect_err("not a fast-forward");
    match &error {
        GitError::Cli { stderr, .. } => assert!(stderr.contains("fast-forward"), "{stderr}"),
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(f.git(&["status", "--porcelain"]), "");
    f.tick();
}

#[test]
fn a_fast_forward_only_pull_moves_says_up_to_date_or_refuses_whatever_the_config_says() {
    let mut f = Fixture::basic().with_remote();
    let e = engine(&f);
    // The user's configuration asks for merge commits; a fast-forward-only pull ignores it.
    f.git(&["config", "pull.ff", "false"]);
    f.git(&["config", "merge.ff", "false"]);
    let tip = f.rev("main");
    f.git(&["reset", "-q", "--hard", "main~1"]);
    // No remote and no branch: the branch's upstream, as a bulk pull asks for it.
    let request = PullRequest {
        remote: None,
        branch: None,
        rebase: false,
        ff_only: true,
    };
    let outcome = e
        .pull(&request, Prompts::Allowed, &mut |_| {}, &never())
        .expect("pull");
    assert_eq!(outcome.kind, OutcomeKind::FastForward);
    assert_eq!(f.head(), tip);
    let outcome = e
        .pull(&request, Prompts::Allowed, &mut |_| {}, &never())
        .expect("pull");
    assert_eq!(outcome.kind, OutcomeKind::UpToDate);
    assert_eq!(f.head(), tip);

    // develop is 2 ahead and 3 behind origin/develop: git refuses, nothing moves or stays
    // half done.
    f.git(&["switch", "-q", "develop"]);
    let before = f.head();
    let error = e
        .pull(&request, Prompts::Allowed, &mut |_| {}, &never())
        .expect_err("not a fast-forward");
    match &error {
        GitError::Cli { stderr, .. } => {
            assert!(stderr.contains("Not possible to fast-forward"), "{stderr}");
        }
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(f.head(), before);
    assert_eq!(f.git(&["status", "--porcelain"]), "");
    assert!(!f.try_git(&["rev-parse", "-q", "--verify", "MERGE_HEAD"]).0);

    // Fast-forward only is a merge's rule: with a rebase it is refused before git runs.
    let error = e
        .pull(
            &PullRequest {
                rebase: true,
                ..request.clone()
            },
            Prompts::Allowed,
            &mut |_| {},
            &never(),
        )
        .expect_err("rebase and fast-forward only");
    assert!(
        error.to_string().contains("rebase or a fast-forward only"),
        "{error}"
    );
    assert_eq!(f.head(), before);
    f.tick();
}

/// Points the remote `probe` at an SSH URL whose command writes the environment git starts
/// it with to `out` and fails, as a server that refuses the key would. `ssh.variant=simple`
/// spares git's `-G` probe of the command.
fn add_env_probe(f: &Fixture, out: &Path) {
    let out = out.to_str().expect("utf-8 temp path").replace('\\', "/");
    f.git(&["config", "ssh.variant", "simple"]);
    f.git(&[
        "config",
        "core.sshCommand",
        &format!("env > '{out}'; false"),
    ]);
    f.git(&["remote", "add", "probe", "ssh://example.invalid/probe.git"]);
}

/// The value of `name` in an `env` listing; `None` when it is not set.
fn env_value<'a>(listing: &'a str, name: &str) -> Option<&'a str> {
    listing
        .lines()
        .find_map(|line| line.strip_prefix(name)?.strip_prefix('='))
}

#[test]
fn nothing_may_prompt_in_a_fetch_pull_or_push_that_asks_so_and_a_local_remote_works_both_ways() {
    let mut f = Fixture::basic().with_remote();
    let e = engine(&f);
    for prompts in [Prompts::Allowed, Prompts::Never] {
        e.fetch(Some("origin"), false, prompts, &mut |_| {}, &never())
            .expect("a local remote needs no sign-in");
    }
    f.write(
        "never.txt",
        "pushed without prompts
",
    );
    f.commit("n1: pushed without prompts");
    let push_main = PushRequest {
        remote: Some("origin".to_owned()),
        branch: Some("main".to_owned()),
        set_upstream: false,
        force_with_lease: false,
    };
    e.push(&push_main, Prompts::Never, &mut |_| {}, &never())
        .expect("push");
    assert_eq!(origin_rev(&f, "main"), f.head());

    let out = f.sibling("ssh-env.txt");
    add_env_probe(&f, &out);
    let pull_probe = PullRequest {
        remote: Some("probe".to_owned()),
        branch: Some("main".to_owned()),
        rebase: false,
        ff_only: true,
    };
    let push_probe = PushRequest {
        remote: Some("probe".to_owned()),
        ..push_main
    };
    type Run<'a> = Box<dyn Fn(Prompts) -> Result<(), GitError> + 'a>;
    let runs: [(&str, Run<'_>); 3] = [
        (
            "fetch",
            Box::new(|prompts| {
                e.fetch(Some("probe"), false, prompts, &mut |_| {}, &never())
                    .map(drop)
            }),
        ),
        (
            "pull",
            Box::new(|prompts| {
                e.pull(&pull_probe, prompts, &mut |_| {}, &never())
                    .map(drop)
            }),
        ),
        (
            "push",
            Box::new(|prompts| {
                e.push(&push_probe, prompts, &mut |_| {}, &never())
                    .map(drop)
            }),
        ),
    ];
    for (name, run) in &runs {
        for prompts in [Prompts::Never, Prompts::Allowed] {
            let _ = fs::remove_file(&out);
            let error = run(prompts).expect_err("the probe refuses");
            assert!(matches!(error, GitError::Cli { .. }), "{name}: {error:?}");
            let listing = fs::read_to_string(&out).unwrap_or_else(|error| {
                panic!("{name}: the SSH command did not run ({error}); a GIT_SSH_COMMAND in the environment replaces it")
            });
            assert_eq!(
                env_value(&listing, "GIT_TERMINAL_PROMPT"),
                Some("0"),
                "{name}"
            );
            if prompts == Prompts::Never {
                assert_eq!(
                    env_value(&listing, "GCM_INTERACTIVE"),
                    Some("never"),
                    "{name}"
                );
                assert_eq!(
                    env_value(&listing, "SSH_ASKPASS_REQUIRE"),
                    Some("force"),
                    "{name}"
                );
                assert_eq!(
                    env_value(&listing, "SSH_ASKPASS"),
                    Some(failing_askpass()),
                    "{name}"
                );
                assert_eq!(env_value(&listing, "GIT_ASKPASS"), Some(""), "{name}");
            } else {
                // Allowed adds nothing: the helpers see what the app was started with.
                for variable in [
                    "GCM_INTERACTIVE",
                    "SSH_ASKPASS_REQUIRE",
                    "SSH_ASKPASS",
                    "GIT_ASKPASS",
                ] {
                    assert_eq!(
                        env_value(&listing, variable),
                        std::env::var(variable).ok().as_deref(),
                        "{name}: {variable}"
                    );
                }
            }
        }
    }
    f.tick();
}

/// Commits `file` on `main` and pushes it to `origin`, then takes local `main` back one
/// commit: the next pull fast-forwards onto it.
fn upstream_one_ahead(f: &mut Fixture, file: &str, content: &str) -> String {
    f.write(file, content);
    let tip = f.commit(&format!("upstream: {file}"));
    f.git(&["push", "-q", "origin", "main"]);
    f.git(&["reset", "-q", "--hard", "HEAD~1"]);
    tip
}

#[test]
fn a_bulk_pull_checks_out_what_it_brought_with_nothing_allowed_to_prompt() {
    let mut f = Fixture::basic().with_remote();
    let e = engine(&f);
    // A smudge filter stands for Git LFS, which asks the credential helpers for its server
    // while the fast-forward checks the file out.
    let out = f.sibling("smudge-env.txt");
    let out_sh = out.to_str().expect("utf-8 temp path").replace('\\', "/");
    f.git(&[
        "config",
        "filter.probe.smudge",
        &format!("env > '{out_sh}'; cat"),
    ]);
    f.git(&["config", "filter.probe.clean", "cat"]);
    fs::write(
        f.git_dir().join("info").join("attributes"),
        "*.probe filter=probe\n",
    )
    .expect("attributes");
    let tip = upstream_one_ahead(&mut f, "tiles.probe", "tile\n");
    let _ = fs::remove_file(&out);
    let request = PullRequest {
        remote: None,
        branch: None,
        rebase: false,
        ff_only: true,
    };
    let outcome = e
        .pull(&request, Prompts::Never, &mut |_| {}, &never())
        .expect("pull");
    assert_eq!(outcome.kind, OutcomeKind::FastForward);
    assert_eq!(f.head(), tip);
    let listing = fs::read_to_string(&out).expect("the smudge filter ran");
    assert_eq!(env_value(&listing, "GCM_INTERACTIVE"), Some("never"));
    assert_eq!(env_value(&listing, "SSH_ASKPASS_REQUIRE"), Some("force"));
    assert_eq!(env_value(&listing, "SSH_ASKPASS"), Some(failing_askpass()));
    assert_eq!(env_value(&listing, "GIT_ASKPASS"), Some(""));
    assert_eq!(env_value(&listing, "GIT_REFLOG_ACTION"), Some("pull"));
    f.tick();
}

#[test]
fn a_fast_forward_only_pull_never_stashes_whatever_merge_autostash_says() {
    let mut f = Fixture::basic().with_remote();
    let e = engine(&f);
    f.git(&["config", "merge.autoStash", "true"]);
    upstream_one_ahead(&mut f, "README.md", "# Fixture\nfrom upstream\n");
    let before = f.head();
    // A local change to the file the upstream changed: a stash, the fast-forward and the
    // stash back would conflict in a repository nobody is looking at.
    f.write("README.md", "# Fixture\nlocal edit\n");
    let request = PullRequest {
        remote: None,
        branch: None,
        rebase: false,
        ff_only: true,
    };
    let error = e
        .pull(&request, Prompts::Never, &mut |_| {}, &never())
        .expect_err("the local change is in the way");
    match &error {
        GitError::Cli { stderr, .. } => {
            assert!(stderr.contains("would be overwritten"), "{stderr}");
        }
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(f.head(), before);
    assert_eq!(f.git(&["stash", "list"]), "");
    assert_eq!(f.git(&["status", "--porcelain"]), " M README.md");
    assert_eq!(
        fs::read_to_string(f.root.join("README.md")).expect("readme"),
        "# Fixture\nlocal edit\n"
    );
    f.tick();
}

#[test]
fn a_pull_whose_upstream_left_the_remote_says_which_ref_was_not_fetched() {
    let f = Fixture::basic().with_remote();
    let e = engine(&f);
    f.git(&["switch", "-q", "develop"]);
    // Someone else deletes the branch on the remote; the tracking ref stays until a prune,
    // so the summary still names the upstream.
    let origin = f.sibling("origin.git");
    f.git_in(&origin, &["branch", "-q", "-D", "develop"]);
    assert!(f.try_git(&["rev-parse", "--verify", "origin/develop"]).0);
    let request = PullRequest {
        remote: None,
        branch: None,
        rebase: false,
        ff_only: true,
    };
    let error = e
        .pull(&request, Prompts::Never, &mut |_| {}, &never())
        .expect_err("nothing to merge");
    assert_eq!(error.code(), "refs.not_found", "{error}");
    assert!(error.to_string().contains("refs/heads/develop"), "{error}");
    // `git pull` refuses the same way, in its own words.
    let (ok, _, stderr) = f.try_git(&["pull", "--ff-only"]);
    assert!(!ok);
    assert!(stderr.contains("no such ref was fetched"), "{stderr}");
}

#[test]
fn a_fetch_without_a_remote_fetches_every_remote() {
    let f = Fixture::basic().with_remote();
    let e = engine(&f);
    let second = f.sibling("second.git");
    let second = second.to_str().expect("utf-8");
    f.git(&["init", "-q", "--bare", second]);
    f.git(&["push", "-q", second, "main:on-second"]);
    let origin = f.sibling("origin.git");
    f.git_in(&origin, &["branch", "on-origin", "main"]);
    e.remote_add("second", second, &never()).expect("add");
    e.fetch(None, false, Prompts::Allowed, &mut |_| {}, &never())
        .expect("fetch --all");
    assert!(f.try_git(&["rev-parse", "--verify", "origin/on-origin"]).0);
    assert!(f.try_git(&["rev-parse", "--verify", "second/on-second"]).0);
}

#[test]
fn a_branch_that_starts_with_a_plus_never_forces() {
    let mut f = Fixture::basic().with_remote();
    let e = engine(&f);
    // The remote's develop is ahead: a plain push is rejected, and `+develop` would be the
    // forced refspec, not a branch name.
    let remote_tip = origin_rev(&f, "develop");
    let error = e
        .push(
            &PushRequest {
                remote: Some("origin".to_owned()),
                branch: Some("+develop".to_owned()),
                set_upstream: false,
                force_with_lease: false,
            },
            Prompts::Allowed,
            &mut |_| {},
            &never(),
        )
        .expect_err("refused");
    assert!(!matches!(error, GitError::Cli { .. }), "{error:?}");
    assert_eq!(origin_rev(&f, "develop"), remote_tip);
    let error = e
        .pull(
            &PullRequest {
                remote: Some("origin".to_owned()),
                branch: Some("+develop".to_owned()),
                rebase: false,
                ff_only: false,
            },
            Prompts::Allowed,
            &mut |_| {},
            &never(),
        )
        .expect_err("refused");
    assert!(!matches!(error, GitError::Cli { .. }), "{error:?}");
    f.tick();
}
