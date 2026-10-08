//! The content search of the walk (`git log -S` and `-G`) against git on fixture repositories.

mod support;

use std::thread;
use std::time::{Duration, Instant};

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{CommitNode, ContentFilter, WalkFilter, WalkOptions, WalkOrder, WalkScope};
use support::Fixture;

fn open(f: &Fixture) -> Git2Engine {
    Git2Engine::open(&f.root).expect("open fixture")
}

fn hashes(nodes: &[CommitNode]) -> Vec<String> {
    nodes.iter().map(|node| node.hash.clone()).collect()
}

/// A content search, the lazy order the app uses.
fn searching(text: &str, lines: bool) -> WalkOptions {
    options(WalkFilter {
        content: Some(ContentFilter {
            text: text.to_owned(),
            lines,
        }),
        ..WalkFilter::default()
    })
}

fn options(filter: WalkFilter) -> WalkOptions {
    WalkOptions {
        filter: Some(filter),
        order: WalkOrder::Lazy,
        ..WalkOptions::default()
    }
}

/// Every page of the walk, in order.
fn walk(engine: &Git2Engine, scope: &WalkScope, options: &WalkOptions) -> Vec<CommitNode> {
    let mut walk = engine.walk(scope, options, &Cancel::never()).expect("walk");
    let mut nodes = Vec::new();
    loop {
        let page = walk.next_page(&Cancel::never()).expect("page");
        let done = page.done;
        nodes.extend(page.commits);
        if done {
            break;
        }
    }
    nodes
}

/// `git log --format=%H <args>`, one hash a line.
fn git_log(f: &Fixture, args: &[&str]) -> Vec<String> {
    let mut argv = vec!["log", "--format=%H"];
    argv.extend_from_slice(args);
    f.git(&argv).lines().map(str::to_owned).collect()
}

/// Commits as another author: stages everything and commits with the next clock tick.
fn commit_as(f: &mut Fixture, name: &str, message: &str) -> String {
    f.tick();
    f.git(&["add", "-A"]);
    let email = format!("{}@example.com", name.to_lowercase());
    let date = format!("{} +0000", f.now());
    f.git_with_env(
        &[
            ("GIT_AUTHOR_NAME", name),
            ("GIT_AUTHOR_EMAIL", &email),
            ("GIT_AUTHOR_DATE", &date),
            ("GIT_COMMITTER_DATE", &date),
        ],
        &["commit", "-q", "-m", message],
    );
    f.head()
}

/// "Added or removed" lists the commits that change how many times the text appears in a
/// file: not a move of the file that holds it, nor an edit beside it.
#[test]
fn added_or_removed_lists_what_git_log_s_lists() {
    let mut f = Fixture::empty();
    f.write("src/retry.ts", "export const retryLimit = 3;\n");
    let added = f.commit("add retryLimit");
    f.write("README.md", "# readme\n");
    f.commit("readme");
    f.git(&["mv", "src/retry.ts", "src/limits.ts"]);
    f.commit("move the file");
    f.write(
        "src/limits.ts",
        "export const retryLimit = 3;\nexport const other = 1;\n",
    );
    f.commit("an edit beside it");
    f.write("src/limits.ts", "export const other = 1;\n");
    let removed = f.commit("remove retryLimit");
    let engine = open(&f);
    for lines in [false, true] {
        let nodes = walk(&engine, &WalkScope::All, &searching("retryLimit", lines));
        assert_eq!(
            hashes(&nodes),
            vec![removed.clone(), added.clone()],
            "lines {lines}"
        );
        assert!(nodes.iter().all(|n| n.lane == 0 && n.edges.is_empty()));
    }
    assert_eq!(
        git_log(&f, &["--all", "-SretryLimit"]),
        vec![removed.clone(), added.clone()]
    );
    assert_eq!(
        git_log(&f, &["--all", "-GretryLimit"]),
        vec![removed, added]
    );
}

/// "On a changed line" lists the commits whose diff adds or removes a line holding the text,
/// a parenthesis taken as written; "added or removed" leaves out a swap that keeps the count.
#[test]
fn on_a_changed_line_lists_what_git_log_g_lists() {
    let mut f = Fixture::empty();
    f.write("a.ts", "limit(1)\n");
    let first = f.commit("call limit(");
    f.write("b.ts", "limit 2\n");
    f.commit("mention limit without a call");
    f.write("a.ts", "limit(1)\nlimit(2)\n");
    let second = f.commit("a second call");
    f.write("a.ts", "limit(2)\nlimit(1)\n");
    let swap = f.commit("swap the calls");
    let engine = open(&f);
    let on_lines = walk(&engine, &WalkScope::All, &searching("limit(", true));
    assert_eq!(
        hashes(&on_lines),
        vec![swap.clone(), second.clone(), first.clone()]
    );
    assert_eq!(hashes(&on_lines), git_log(&f, &["--all", "-Glimit\\("]));
    let counted = walk(&engine, &WalkScope::All, &searching("limit(", false));
    assert_eq!(hashes(&counted), vec![second, first]);
    assert_eq!(hashes(&counted), git_log(&f, &["--all", "-Slimit("]));
}

/// Quotes, a backslash, the characters a shell or cmd.exe would read, every character of a
/// regular expression and a non-ASCII letter reach git as written, in both searches; the near
/// misses (a `.` that an unescaped pattern would match, `e` for `é`) are not listed.
#[test]
fn the_text_is_matched_as_written() {
    const TEXT: &str = "say \"a\\b\" 100% ^&|<> .[](){}*+?$ é";
    let mut f = Fixture::empty();
    f.write("odd.txt", &format!("{TEXT}\n"));
    let added = f.commit("add the odd line");
    f.write("dot.txt", "say \"a\\b\" 100% ^&|<> X[](){}*+?$ é\n");
    f.commit("a near miss for the dot");
    f.write("accent.txt", "say \"a\\b\" 100% ^&|<> .[](){}*+?$ e\n");
    f.commit("a near miss for the accent");
    f.write("dash.txt", "-S\n");
    let dash = f.commit("a line that is an option");
    let engine = open(&f);
    for lines in [false, true] {
        let nodes = walk(&engine, &WalkScope::All, &searching(TEXT, lines));
        assert_eq!(hashes(&nodes), vec![added.clone()], "lines {lines}");
        let nodes = walk(&engine, &WalkScope::All, &searching("-S", lines));
        assert_eq!(hashes(&nodes), vec![dash.clone()], "lines {lines}");
    }
}

/// Within a path, with an author: the commits `git log -S<text> -- <path>` lists whose author
/// matches; the exact order is git's `--date-order`.
#[test]
fn within_paths_with_the_other_filters() {
    let mut f = Fixture::empty();
    f.write("apps/api/retry.ts", "retry()\n");
    let api_ane = commit_as(&mut f, "Ane", "api retry by ane");
    f.write("apps/web/retry.ts", "retry()\n");
    commit_as(&mut f, "Fixture", "web retry");
    f.write("apps/api/retry.ts", "retry()\nretry()\n");
    commit_as(&mut f, "Fixture", "api retry again");
    f.write("apps/api/other.ts", "retry\n");
    let other_ane = commit_as(&mut f, "Ane", "api other by ane");
    let engine = open(&f);
    let filter = |author: Option<&str>| WalkFilter {
        paths: vec!["apps/api".to_owned()],
        author: author.map(str::to_owned),
        content: Some(ContentFilter {
            text: "retry".to_owned(),
            lines: false,
        }),
        ..WalkFilter::default()
    };
    let nodes = walk(&engine, &WalkScope::All, &options(filter(Some("ane"))));
    assert_eq!(hashes(&nodes), vec![other_ane, api_ane]);
    assert_eq!(
        hashes(&nodes),
        git_log(&f, &["--all", "--author=Ane", "-Sretry", "--", "apps/api"])
    );
    let exact = walk(
        &engine,
        &WalkScope::All,
        &WalkOptions {
            order: WalkOrder::DateTopo,
            ..options(filter(None))
        },
    );
    assert_eq!(
        hashes(&exact),
        git_log(&f, &["--date-order", "--all", "-Sretry", "--", "apps/api"])
    );
}

/// Under clock skew the two orders differ, and each is git's: plain `git log` shows the root
/// (dated after one of its children) before that child, `--date-order` never does.
#[test]
fn each_order_is_gits_under_clock_skew() {
    let mut f = Fixture::empty();
    let base = f.now();
    f.set_clock(base + 240);
    f.write("a.ts", "retry\n");
    let root = f.commit("root, dated 300");
    f.git(&["checkout", "-q", "-b", "p"]);
    f.set_clock(base + 40);
    f.write("p.ts", "retry\n");
    let older = f.commit("a child dated 100");
    f.git(&["checkout", "-q", "-b", "q", &root]);
    f.set_clock(base + 290);
    f.write("q.ts", "retry\n");
    let newer = f.commit("a child dated 350");
    f.set_clock(base + 340);
    f.git(&["merge", "-q", "--no-ff", "-m", "merge p", "p"]);
    let engine = open(&f);
    let lazy = walk(&engine, &WalkScope::All, &searching("retry", false));
    assert_eq!(
        hashes(&lazy),
        vec![newer.clone(), root.clone(), older.clone()]
    );
    assert_eq!(hashes(&lazy), git_log(&f, &["--all", "-Sretry"]));
    let exact = walk(
        &engine,
        &WalkScope::All,
        &WalkOptions {
            order: WalkOrder::DateTopo,
            ..searching("retry", false)
        },
    );
    assert_eq!(hashes(&exact), vec![newer, older, root]);
    assert_eq!(
        hashes(&exact),
        git_log(&f, &["--date-order", "--all", "-Sretry"])
    );
}

/// Every scope kind lists what `git log -S` lists for it; a merge is not diffed, as in git.
#[test]
fn each_scope_lists_what_git_lists() {
    let f = Fixture::basic();
    let engine = open(&f);
    let scopes = [
        (WalkScope::All, "--all"),
        (
            WalkScope::Ref {
                name: "main".to_owned(),
            },
            "main",
        ),
        (
            WalkScope::Ref {
                name: "develop".to_owned(),
            },
            "develop",
        ),
        (
            WalkScope::Ref {
                name: "v1".to_owned(),
            },
            "v1",
        ),
        (
            WalkScope::Range {
                exclude: "v1".to_owned(),
                include: "main".to_owned(),
            },
            "v1..main",
        ),
        (
            WalkScope::Refs {
                names: vec![
                    "refs/heads/develop".to_owned(),
                    "refs/heads/gone".to_owned(),
                ],
            },
            "develop",
        ),
    ];
    for (scope, git_scope) in scopes {
        for lines in [false, true] {
            let nodes = walk(&engine, &scope, &searching("pub fn", lines));
            let pickaxe = if lines { "-Gpub fn" } else { "-Spub fn" };
            assert_eq!(
                hashes(&nodes),
                git_log(&f, &[git_scope, pickaxe]),
                "{git_scope} lines {lines}"
            );
        }
    }
    let all = walk(&engine, &WalkScope::All, &searching("pub fn", false));
    assert_eq!(all.len(), 3, "c2, d1 and d2; the merge is not diffed");
}

/// The repository's configuration changes nothing: signatures stay off stdout, a single path
/// is not followed across a rename, the root commit is diffed and renames are detected.
#[test]
fn the_users_configuration_changes_nothing() {
    let mut f = Fixture::empty();
    f.write("a.txt", "retryLimit\n");
    let root = f.commit("root adds it");
    f.write("b.txt", "unrelated\n");
    f.commit("unrelated");
    f.git(&["mv", "a.txt", "c.txt"]);
    let moved = f.commit("move it");
    f.write("d.txt", "retryLimit again\n");
    f.commit("add it again");
    let signed = sign_head(&f);
    let engine = open(&f);
    let all = |engine: &Git2Engine| {
        hashes(&walk(
            engine,
            &WalkScope::All,
            &searching("retryLimit", false),
        ))
    };
    let in_c = |engine: &Git2Engine| {
        hashes(&walk(
            engine,
            &WalkScope::All,
            &options(WalkFilter {
                paths: vec!["c.txt".to_owned()],
                content: Some(ContentFilter {
                    text: "retryLimit".to_owned(),
                    lines: false,
                }),
                ..WalkFilter::default()
            }),
        ))
    };
    assert_eq!(all(&engine), vec![signed.clone(), root.clone()]);
    assert_eq!(in_c(&engine), vec![moved.clone()]);
    for (key, value) in [
        ("log.showSignature", "true"),
        ("log.follow", "true"),
        ("log.showRoot", "false"),
        ("diff.renames", "false"),
    ] {
        f.git(&["config", key, value]);
    }
    let engine = open(&f);
    assert_eq!(all(&engine), vec![signed, root]);
    assert_eq!(in_c(&engine), vec![moved]);
}

/// The search reads the content as stored, the content the diffs show, not what a textconv
/// filter of the repository makes of it (git log runs one by default).
#[test]
fn the_stored_content_is_searched_not_a_textconv_output() {
    let mut f = Fixture::empty();
    f.write(".gitattributes", "*.txt diff=upper\n");
    f.write("a.txt", "retrylimit\n");
    let added = f.commit("a lowercase word");
    f.git(&["config", "diff.upper.textconv", "tr a-z A-Z <"]);
    // The filter is live: git's own search finds the uppercase text it makes, not the stored.
    assert_eq!(git_log(&f, &["--all", "-SRETRYLIMIT"]), vec![added.clone()]);
    assert!(git_log(&f, &["--all", "-Sretrylimit"]).is_empty());
    let engine = open(&f);
    for lines in [false, true] {
        let stored = walk(&engine, &WalkScope::All, &searching("retrylimit", lines));
        assert_eq!(hashes(&stored), vec![added.clone()], "lines {lines}");
        assert!(walk(&engine, &WalkScope::All, &searching("RETRYLIMIT", lines)).is_empty());
    }
}

/// Stopping a walk now ends its git before it returns, for the app's exit; the walk is then
/// done.
#[test]
fn a_search_stops_now() {
    let f = chain_touching(1_500);
    let engine = open(&f);
    let options = WalkOptions {
        page_size: 10,
        ..searching("line", true)
    };
    let mut walk = engine
        .walk(&WalkScope::All, &options, &Cancel::never())
        .expect("walk");
    let first = walk.next_page(&Cancel::never()).expect("page");
    assert_eq!(first.commits.len(), 10);
    let started = Instant::now();
    walk.stop_now();
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    let after = walk
        .next_page(&Cancel::never())
        .expect("an empty done page");
    assert!(after.commits.is_empty() && after.done);
}

/// The configuration's encodings re-encode nothing: the hashes come in UTF-8.
#[test]
fn an_encoding_of_the_configuration_changes_nothing() {
    let mut f = Fixture::empty();
    f.write("a.txt", "retryLimit\n");
    let added = f.commit("add it");
    for key in ["i18n.logOutputEncoding", "i18n.commitEncoding"] {
        f.git(&["config", key, "UTF-16"]);
        let engine = open(&f);
        for lines in [false, true] {
            let nodes = walk(&engine, &WalkScope::All, &searching("retryLimit", lines));
            assert_eq!(hashes(&nodes), vec![added.clone()], "{key}, lines {lines}");
        }
        f.git(&["config", "--unset", key]);
    }
}

/// A submodule's commit is not text: its pointer, which git shows as `Subproject commit
/// <hash>`, is searched by neither choice, whatever `diff.ignoreSubmodules` or the submodule's
/// own `ignore` say.
#[test]
fn a_submodule_pointer_is_not_searched() {
    let mut f = Fixture::empty();
    f.write("README.md", "this commit mentions commit\n");
    let readme = f.commit("readme mentions commit");
    let a1 = "a1".repeat(20);
    let b2 = "b2".repeat(20);
    for (target, message) in [(&a1, "add submodule lib at a1"), (&b2, "bump lib to b2")] {
        // `git add -A` would drop a submodule without its folder: the index takes it as is.
        f.tick();
        let entry = format!("160000,{target},lib");
        f.git(&["update-index", "--add", "--cacheinfo", &entry]);
        f.git(&["commit", "-q", "-m", message]);
    }
    let settings = [
        None,
        Some(("diff.ignoreSubmodules", "none")),
        Some(("submodule.lib.ignore", "all")),
    ];
    for setting in settings {
        if let Some((key, value)) = setting {
            f.git(&["config", key, value]);
        }
        let engine = open(&f);
        for lines in [false, true] {
            let mentions = walk(&engine, &WalkScope::All, &searching("commit", lines));
            assert_eq!(
                hashes(&mentions),
                vec![readme.clone()],
                "{setting:?}, lines {lines}"
            );
            assert!(walk(&engine, &WalkScope::All, &searching("b2b2b2", lines)).is_empty());
        }
        if let Some((key, _)) = setting {
            f.git(&["config", "--unset", key]);
        }
    }
    // git itself searches the pointer: the bump changes a line holding "commit".
    assert_eq!(git_log(&f, &["--all", "-Gcommit"]).len(), 3);
}

/// `core.bigFileThreshold` changes nothing: a text file above it is still searched line by
/// line, as the diffs show it.
#[test]
fn a_large_text_file_is_searched_whatever_the_threshold() {
    let mut f = Fixture::empty();
    let body: String = (0..200)
        .map(|i| format!("line {i} of a text file\n"))
        .collect();
    f.write("big.txt", &body);
    f.commit("a big file");
    f.write("big.txt", &format!("{body}bigneedle\n"));
    let gained = f.commit("the big file gains bigneedle");
    f.git(&["config", "core.bigFileThreshold", "1k"]);
    assert!(
        git_log(&f, &["--all", "-Gbigneedle"]).is_empty(),
        "the threshold makes git skip the file"
    );
    let engine = open(&f);
    for lines in [false, true] {
        let nodes = walk(&engine, &WalkScope::All, &searching("bigneedle", lines));
        assert_eq!(hashes(&nodes), vec![gained.clone()], "lines {lines}");
    }
}

/// `diff.renameLimit` changes nothing: moves with an edit are found up to git's default.
#[test]
fn the_rename_limit_of_the_configuration_changes_nothing() {
    let mut f = Fixture::empty();
    f.write("f1.txt", "limitme\none\n");
    f.write("f2.txt", "limitme\ntwo\n");
    let added = f.commit("add f1 f2 with limitme");
    f.git(&["mv", "f1.txt", "g1.txt"]);
    f.git(&["mv", "f2.txt", "g2.txt"]);
    f.append("g1.txt", "edit\n");
    f.append("g2.txt", "edit\n");
    f.commit("move f1 f2 to g1 g2 with an edit");
    f.git(&["config", "diff.renameLimit", "1"]);
    assert_eq!(
        git_log(&f, &["--all", "-Slimitme"]).len(),
        2,
        "the limit makes git list the moves"
    );
    let engine = open(&f);
    let nodes = walk(&engine, &WalkScope::All, &searching("limitme", false));
    assert_eq!(hashes(&nodes), vec![added]);
}

/// Replace refs are left out, as the graph leaves them out: a grafted history is searched, and
/// its path history listed, as libgit2 walks it.
#[test]
fn replace_refs_are_left_out_like_the_graph() {
    let mut f = Fixture::empty();
    f.write("a.txt", "oldneedle\n");
    f.commit("old history adds oldneedle");
    f.write("a.txt", "oldneedle\nmore\n");
    let old_tip = f.commit("old tip");
    f.git(&["checkout", "-q", "--orphan", "fresh"]);
    f.write("a.txt", "oldneedle\nmore\nnewneedle\n");
    let new_root = f.commit("new root: an import with newneedle");
    f.git(&["replace", "--graft", &new_root, &old_tip]);
    // git follows the graft into the old history; the graph does not.
    assert_ne!(
        git_log(&f, &["-Soldneedle", "fresh"]),
        vec![new_root.clone()],
        "the graft is live"
    );
    let engine = open(&f);
    let fresh = WalkScope::Ref {
        name: "fresh".to_owned(),
    };
    for lines in [false, true] {
        let nodes = walk(&engine, &fresh, &searching("oldneedle", lines));
        assert_eq!(hashes(&nodes), vec![new_root.clone()], "lines {lines}");
    }
    let by_path = walk(
        &engine,
        &fresh,
        &options(WalkFilter {
            paths: vec!["a.txt".to_owned()],
            ..WalkFilter::default()
        }),
    );
    assert_eq!(hashes(&by_path), vec![new_root]);
}

/// Gives HEAD's commit a `gpgsig` header that verifies as nothing, as a signed commit
/// would carry; returns the new HEAD. With `log.showSignature`, git asks gpg about it and
/// prints gpg's answer among the hashes.
fn sign_head(f: &Fixture) -> String {
    let raw = f.git(&["cat-file", "commit", "HEAD"]);
    let (header, message) = raw.split_once("\n\n").expect("commit object");
    let signed = format!(
        "{header}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEE\n -----END PGP SIGNATURE-----\n\n{message}\n"
    );
    let path = f.sibling("signed-commit");
    std::fs::write(&path, signed).expect("write the commit");
    let path = path.to_str().expect("utf-8 temp path").to_owned();
    let oid = f.git(&["hash-object", "-t", "commit", "-w", &path]);
    f.git(&["update-ref", "refs/heads/main", &oid]);
    oid
}

/// A text with no match lists nothing and ends; an empty text is no search (the libgit2 walk
/// lists everything).
#[test]
fn no_match_and_an_empty_text() {
    let f = Fixture::basic();
    let engine = open(&f);
    assert!(walk(&engine, &WalkScope::All, &searching("never written", false)).is_empty());
    let empty = walk(&engine, &WalkScope::All, &searching("", false));
    assert_eq!(hashes(&empty), git_log(&f, &["--all"]));
}

/// A search whose matches pile up behind a small page still cancels and drops within 200 ms
/// each.
#[test]
fn a_search_cancels_and_drops_with_lines_pending() {
    let f = chain_touching(1_500);
    let engine = open(&f);
    let options = WalkOptions {
        page_size: 10,
        ..searching("line", true)
    };
    let mut walk = engine
        .walk(&WalkScope::All, &options, &Cancel::never())
        .expect("walk");
    let first = walk.next_page(&Cancel::never()).expect("page");
    assert_eq!(first.commits.len(), 10);
    thread::sleep(Duration::from_millis(500));
    let cancel = Cancel::new();
    cancel.cancel();
    let started = Instant::now();
    let error = walk.next_page(&cancel).expect_err("cancelled");
    assert!(matches!(error, GitError::Cancelled), "{error:?}");
    assert!(
        started.elapsed() < Duration::from_millis(200),
        "{:?}",
        started.elapsed()
    );
    let walk = engine
        .walk(&WalkScope::All, &options, &Cancel::never())
        .expect("walk");
    thread::sleep(Duration::from_millis(300));
    let started = Instant::now();
    drop(walk);
    assert!(
        started.elapsed() < Duration::from_millis(200),
        "{:?}",
        started.elapsed()
    );
}

/// A repository with `count` commits in one line, each rewriting `file.txt`'s one line,
/// written with libgit2 (no processes): every commit changes a line holding "line".
fn chain_touching(count: usize) -> Fixture {
    let f = Fixture::empty();
    let repo = git2::Repository::open(&f.root).expect("open with git2");
    let mut parent: Option<git2::Oid> = None;
    for i in 0..count {
        let blob = repo.blob(format!("line {i}\n").as_bytes()).expect("blob");
        let mut builder = repo.treebuilder(None).expect("tree builder");
        builder.insert("file.txt", blob, 0o100644).expect("entry");
        let tree_id = builder.write().expect("tree");
        let tree = repo.find_tree(tree_id).expect("tree object");
        let time = git2::Time::new(1_704_067_200 + 60 * i as i64, 0);
        let signature =
            git2::Signature::new("Chain", "chain@example.com", &time).expect("signature");
        let parent_commit = parent.map(|oid| repo.find_commit(oid).expect("parent commit"));
        let parents: Vec<&git2::Commit> = parent_commit.iter().collect();
        let oid = repo
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                &format!("touch {i}"),
                &tree,
                &parents,
            )
            .expect("commit");
        parent = Some(oid);
    }
    f
}
