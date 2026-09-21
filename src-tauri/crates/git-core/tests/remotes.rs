//! `Git2Engine` remotes, fetch, pull and push against a local bare remote.

mod support;

use std::sync::{Arc, Mutex};

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{OutcomeKind, PullRequest, PushRequest};
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
    let second = f.sibling("second.git");
    f.git(&["init", "-q", "--bare", second.to_str().expect("utf-8")]);
    e.remote_add("second", second.to_str().expect("utf-8"), &never())
        .expect("add");
    let remotes = e.remotes(&never()).expect("remotes");
    assert_eq!(
        remotes.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(),
        ["origin", "second"]
    );
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
            &mut |_| {},
            &never(),
        )
        .expect_err("rejected");
    match error {
        GitError::Cli { stderr, .. } => assert!(stderr.contains("rejected"), "{stderr}"),
        other => panic!("unexpected {other:?}"),
    }
    // With a lease the push is accepted only when the tracking ref is current: fetch first.
    e.fetch(Some("origin"), false, &mut |_| {}, &never())
        .expect("fetch");
    let local = f.rev("develop");
    e.push(
        &PushRequest {
            remote: Some("origin".to_owned()),
            branch: Some("develop".to_owned()),
            set_upstream: false,
            force_with_lease: true,
        },
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
    e.fetch(Some("origin"), false, &mut |_| {}, &never())
        .expect("fetch");
    assert!(f.try_git(&["rev-parse", "--verify", "origin/gone"]).0);
    f.git_in(&origin, &["branch", "-D", "gone"]);
    e.fetch(Some("origin"), true, &mut |_| {}, &never())
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
            },
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
            },
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
    let mut f = Fixture::basic().with_remote();
    let e = engine(&f);
    // Enough data that the push is not over before the cancel: a few MB of random-ish blobs.
    for i in 0..40 {
        let content: String = (0..20_000)
            .map(|j| ((i * 31 + j * 7) % 26 + 97) as u8 as char)
            .collect();
        f.write(&format!("big/{i}.txt"), &content);
    }
    f.commit("big");
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
            &mut |_| {},
            &cancel,
        )
        .expect_err("cancelled");
    assert!(matches!(error, GitError::Cancelled), "{error:?}");
}
