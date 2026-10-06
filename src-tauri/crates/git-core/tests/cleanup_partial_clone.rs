//! A partial clone (`--filter=blob:none`): the cleanup's merge check needs blobs the clone
//! lacks, which git would fetch from the promisor remote. The listing is a read: it reaches no
//! network (the dialog's "Fetch and prune" does) and asks for no credentials. A test binary of
//! its own, since it traces git through the process's environment.

mod support;

use git_core::engine::{Cancel, GitEngine};
use git_core::git2_engine::Git2Engine;
use git_core::types::CleanupReason;
use support::Fixture;

#[test]
fn the_listing_of_a_partial_clone_fetches_nothing() {
    let mut f = Fixture::basic();
    f.write("f.txt", "l1\nl2\nl3\nl4\nl5\n");
    f.commit("base");
    f.git(&["switch", "-q", "-c", "feat", "main"]);
    f.write("f.txt", "l1\nl2 feat\nl3\nl4\nl5\n");
    f.commit("feat");
    f.git(&["switch", "-q", "main"]);
    let origin = f.sibling("origin.git");
    let origin_text = origin.to_string_lossy().into_owned();
    f.git(&["init", "-q", "--bare", "-b", "main", &origin_text]);
    f.git_in(&origin, &["config", "uploadpack.allowFilter", "true"]);
    f.git_in(
        &origin,
        &["config", "uploadpack.allowAnySHA1InWant", "true"],
    );
    f.git(&["push", "-q", &origin_text, "main", "feat"]);
    // The clone: blobs on demand, feat tracking its remote branch.
    let url = format!(
        "file://{}",
        origin_text.replace(std::path::MAIN_SEPARATOR, "/")
    );
    let clone = f.sibling("clone");
    let clone_text = clone.to_string_lossy().into_owned();
    f.git(&[
        "clone",
        "-q",
        "--filter=blob:none",
        "--no-checkout",
        &url,
        &clone_text,
    ]);
    f.git_in(&clone, &["branch", "-q", "--track", "feat", "origin/feat"]);
    // On the remote: feat squash-merged, main edited elsewhere in the file, feat deleted.
    f.git(&["merge", "-q", "--squash", "feat"]);
    f.commit("squash feat");
    f.write("f.txt", "l1\nl2 feat\nl3\nl4\nl5 later\n");
    f.commit("later");
    f.git(&["push", "-q", &origin_text, "main"]);
    f.git(&["push", "-q", &origin_text, "--delete", "feat"]);
    f.git_in(&clone, &["fetch", "-q", "--prune", "origin"]);
    assert!(f
        .git_in(&clone, &["branch", "-vv"])
        .contains("[origin/feat: gone]"));
    let missing = f.git_in(
        &clone,
        &[
            "rev-list",
            "--objects",
            "--missing=print",
            "origin/main",
            "feat",
        ],
    );
    assert!(
        missing.lines().any(|line| line.starts_with('?')),
        "{missing}"
    );
    let trace = f.sibling("trace.txt");
    std::env::set_var("GIT_TRACE", &trace);
    let found = Git2Engine::open(&clone)
        .expect("open")
        .cleanup_candidates(&Cancel::never());
    std::env::remove_var("GIT_TRACE");
    let traced = std::fs::read_to_string(&trace).unwrap_or_default();
    assert!(
        traced.contains("merge-tree --stdin"),
        "the trace saw the merge check: {traced}"
    );
    let fetches: Vec<&str> = traced
        .lines()
        .filter(|line| line.contains("built-in: git fetch"))
        .collect();
    assert!(fetches.is_empty(), "the listing fetched: {fetches:?}");
    // Without the blobs the check answers nothing, and the branch reads as not checked.
    let found = found.expect("the listing answers");
    assert!(
        found
            .candidates
            .iter()
            .any(|c| c.name == "feat" && c.reason == CleanupReason::GoneUnchecked),
        "{found:?}"
    );
}
