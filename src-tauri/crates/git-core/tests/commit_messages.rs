//! What the commit box offers to write, against real repositories: the user's recent commit
//! messages and the people who wrote the recent commits, named as `git log --use-mailmap`
//! names them.

mod support;

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use support::Fixture;

/// The author line the commit box shows for the fixture's identity.
const USER: &str = "Fixture <fixture@example.com>";

fn engine(f: &Fixture) -> Git2Engine {
    Git2Engine::open(&f.root).expect("open fixture")
}

/// An empty commit of `message`, by `author` ("Name <email>") or the fixture's identity.
fn commit_as(f: &mut Fixture, author: Option<&str>, message: &str) {
    f.tick();
    let mut args = vec!["commit", "-q", "--allow-empty", "-m", message];
    if let Some(author) = author {
        args.extend(["--author", author]);
    }
    f.git(&args);
}

/// The recent messages of `author`: whether it had an email, and the messages.
fn messages_of(f: &Fixture, author: Option<&str>) -> (bool, Vec<String>) {
    let read = engine(f)
        .recent_messages(author, &Cancel::never())
        .expect("recent messages");
    (
        read.identity,
        read.messages.into_iter().map(|m| m.message).collect(),
    )
}

fn messages(f: &Fixture) -> (bool, Vec<String>) {
    messages_of(f, Some(USER))
}

/// Every author of the commits walked but the user, as the list gives them: (name, email,
/// commits).
fn authors(f: &Fixture) -> Vec<(String, String, u32)> {
    engine(f)
        .recent_authors(Some(USER), &Cancel::never())
        .expect("recent authors")
        .into_iter()
        .map(|a| (a.name, a.email, a.commits))
        .collect()
}

fn author_emails(f: &Fixture) -> Vec<String> {
    authors(f).into_iter().map(|(_, email, _)| email).collect()
}

fn owned(rows: &[(&str, &str, u32)]) -> Vec<(String, String, u32)> {
    rows.iter()
        .map(|(name, email, commits)| ((*name).to_owned(), (*email).to_owned(), *commits))
        .collect()
}

/// `count` empty commits on top of `main` through `git fast-import`, the `i`th by `author(i)`
/// ("Name <email>" as bytes, which need not be UTF-8) with the message `commit i`, one second
/// apart after the fixture's clock.
fn fast_commits(f: &mut Fixture, count: usize, author: impl Fn(usize) -> Vec<u8>) {
    let start = f.now();
    let head = f.head();
    let mut stream = Vec::new();
    for i in 0..count {
        let when = start + 1 + i as i64;
        let who = author(i);
        let message = format!("commit {i}\n");
        stream.extend_from_slice(b"commit refs/heads/main\n");
        for role in [&b"author "[..], b"committer "] {
            stream.extend_from_slice(role);
            stream.extend_from_slice(&who);
            stream.extend_from_slice(format!(" {when} +0000\n").as_bytes());
        }
        stream.extend_from_slice(format!("data {}\n{message}", message.len()).as_bytes());
        if i == 0 {
            stream.extend_from_slice(format!("from {head}\n").as_bytes());
        }
        stream.push(b'\n');
    }
    f.git_with_input(&["fast-import", "--quiet"], &stream);
    f.set_clock(start + count as i64);
}

/// A commit of the message in `bytes` as git stores it (`--cleanup=verbatim`), by the fixture's
/// identity; `config` goes before `commit` (`-c name=value`).
fn commit_file(f: &mut Fixture, config: &[&str], bytes: &[u8]) {
    f.tick();
    let file = f.sibling("message.txt");
    std::fs::write(&file, bytes).expect("write the message");
    let mut all = config.to_vec();
    all.extend(["commit", "-q", "--allow-empty", "--cleanup=verbatim", "-F"]);
    all.push(file.to_str().expect("utf-8 temp path"));
    f.git(&all);
}

/// A commit on HEAD written byte for byte (`hash-object --literally`), as an import or a mailed
/// patch can leave one and `git commit` would not: its author line is `who` and `date` (the
/// fixture's time when none), and `headers` follow the committer line.
fn commit_bytes(f: &mut Fixture, who: &[u8], date: Option<&str>, headers: &[u8], message: &str) {
    f.tick();
    let tree = f.git(&["rev-parse", "HEAD^{tree}"]);
    let parent = f.head();
    let time = f.now();
    let date = date.map_or_else(|| format!("{time} +0000"), str::to_owned);
    let mut body = format!("tree {tree}\nparent {parent}\nauthor ").into_bytes();
    body.extend_from_slice(who);
    body.extend_from_slice(
        format!(" {date}\ncommitter Fixture <fixture@example.com> {time} +0000\n").as_bytes(),
    );
    body.extend_from_slice(headers);
    body.extend_from_slice(format!("\n{message}\n").as_bytes());
    let file = f.sibling("raw.commit");
    std::fs::write(&file, body).expect("write commit");
    let file = file.to_str().expect("utf-8 temp path");
    let oid = f.git(&["hash-object", "-t", "commit", "-w", "--literally", file]);
    f.git(&["update-ref", "refs/heads/main", &oid]);
}

#[test]
fn reads_the_users_distinct_messages_newest_first() {
    let mut f = Fixture::empty();
    commit_as(&mut f, None, "fix: first");
    commit_as(&mut f, Some("Ana Ruiz <ana@example.com>"), "feat: hers");
    commit_as(&mut f, None, "fix: second");
    commit_as(
        &mut f,
        Some("Fixture <FIXTURE@Example.com>"),
        "fix: shouted",
    );
    commit_as(&mut f, None, "fix: first");
    // The user's email and the authors' are compared without case.
    let read = engine(&f)
        .recent_messages(Some("Fixture <Fixture@Example.COM>"), &Cancel::never())
        .expect("recent messages");
    assert!(read.identity);
    let texts: Vec<&str> = read.messages.iter().map(|m| m.message.as_str()).collect();
    assert_eq!(texts, ["fix: first", "fix: shouted", "fix: second"]);
    // The newest commit that carries a message names it.
    assert_eq!(read.messages[0].hash, f.head());
}

#[test]
fn a_message_comes_whole_without_its_trailing_space() {
    let mut f = Fixture::empty();
    commit_as(
        &mut f,
        None,
        "fix(tiles): drop stale entries\n\nThe cache kept them.\n\nCo-authored-by: Ana Ruiz <ana@example.com>\n\n",
    );
    assert_eq!(
        messages(&f).1,
        ["fix(tiles): drop stale entries\n\nThe cache kept them.\n\nCo-authored-by: Ana Ruiz <ana@example.com>"]
    );
}

#[test]
fn no_author_and_an_unborn_head_read_no_message() {
    let f = Fixture::empty();
    assert_eq!(messages(&f), (true, Vec::new()));
    let mut f = Fixture::empty();
    commit_as(&mut f, None, "fix: mine");
    assert_eq!(messages_of(&f, None), (false, Vec::new()));
    // An empty email, as `git var` gives it for an empty `user.email`, names nobody.
    assert_eq!(messages_of(&f, Some("Fixture <>")), (false, Vec::new()));
}

#[test]
fn the_mailmap_makes_an_old_email_the_users() {
    let mut f = Fixture::empty();
    commit_as(
        &mut f,
        Some("Fixture <fixture@old.example>"),
        "fix: from before",
    );
    f.write(
        ".mailmap",
        "Fixture <fixture@example.com> <fixture@old.example>\n",
    );
    assert_eq!(messages(&f).1, ["fix: from before"]);
}

#[test]
fn reads_the_authors_of_every_branch_after_the_mailmap() {
    let mut f = Fixture::empty();
    commit_as(&mut f, None, "mine");
    commit_as(&mut f, Some("Ana R. <ana.ruiz@old.example>"), "a1");
    commit_as(&mut f, Some("Ana R. <ana.ruiz@old.example>"), "a2");
    commit_as(&mut f, Some("Ana Ruiz <ana@example.com>"), "a3");
    commit_as(&mut f, Some("Ana Ruiz <ana@example.com>"), "a4");
    commit_as(&mut f, Some("dependabot[bot] <bot@example.com>"), "deps");
    f.git(&["switch", "-q", "-c", "side"]);
    commit_as(&mut f, Some("Marta Gil <marta@example.com>"), "m1");
    f.git(&["switch", "-q", "-c", "temp"]);
    commit_as(&mut f, Some("Luis Pardo <luis@example.com>"), "l1");
    let luis = f.head();
    f.git(&["switch", "-q", "main"]);
    f.git(&["update-ref", "refs/remotes/origin/luis", &luis]);
    f.git(&["branch", "-q", "-D", "temp"]);
    f.write(
        ".mailmap",
        "Ana Ruiz <ana@example.com> <ana.ruiz@old.example>\n",
    );
    assert_eq!(
        authors(&f),
        owned(&[
            ("Ana Ruiz", "ana@example.com", 4),
            ("Luis Pardo", "luis@example.com", 1),
            ("Marta Gil", "marta@example.com", 1),
            ("dependabot[bot]", "bot@example.com", 1),
        ])
    );
}

#[test]
fn a_cancelled_read_stops() {
    let mut f = Fixture::empty();
    commit_as(&mut f, None, "mine");
    let cancel = Cancel::new();
    cancel.cancel();
    assert!(matches!(
        engine(&f).recent_authors(Some(USER), &cancel),
        Err(GitError::Cancelled)
    ));
    assert!(matches!(
        engine(&f).recent_messages(Some(USER), &cancel),
        Err(GitError::Cancelled)
    ));
}

#[test]
fn the_walk_goes_in_git_logs_order() {
    // Two lines with a commit older than its parent and commits of the same second on both,
    // merged: the messages come in the order `git log` prints them.
    let mut f = Fixture::empty();
    commit_as(&mut f, None, "base");
    let at = f.now();
    let commit_at = |f: &mut Fixture, offset: i64, message: &str| {
        f.set_clock(at + offset - 60);
        commit_as(f, None, message);
    };
    f.git(&["switch", "-q", "-c", "side"]);
    commit_at(&mut f, 1000, "s1");
    commit_at(&mut f, 400, "s2, older than its parent");
    commit_at(&mut f, 1060, "s3");
    f.git(&["switch", "-q", "main"]);
    commit_at(&mut f, 1000, "m1, the second of s1");
    commit_at(&mut f, 1060, "m2, the second of s3");
    f.set_clock(at + 2000);
    f.git(&["merge", "-q", "--no-ff", "-m", "merge", "side"]);
    let logged: Vec<String> = f
        .git(&["log", "--format=%s"])
        .lines()
        .map(str::to_owned)
        .collect();
    assert_eq!(
        logged,
        [
            "merge",
            "m2, the second of s3",
            "s3",
            "m1, the second of s1",
            "s2, older than its parent",
            "s1",
            "base"
        ]
    );
    assert_eq!(messages(&f).1, logged);
}

#[test]
fn ten_messages_from_the_last_five_hundred_commits() {
    let mut f = Fixture::empty();
    for i in 0..12 {
        commit_as(&mut f, None, &format!("fix: {i}"));
    }
    let expected: Vec<String> = (2..12).rev().map(|i| format!("fix: {i}")).collect();
    assert_eq!(messages(&f).1, expected);
    // The user's newest commit 500 commits back is still read; one more and it is not.
    let mut f = Fixture::empty();
    commit_as(&mut f, None, "fix: mine");
    fast_commits(&mut f, 499, |_| b"Ana Ruiz <ana@example.com>".to_vec());
    assert_eq!(messages(&f).1, ["fix: mine"]);
    fast_commits(&mut f, 1, |_| b"Ana Ruiz <ana@example.com>".to_vec());
    assert_eq!(messages(&f), (true, Vec::new()));
}

#[test]
fn fifty_authors_from_the_last_two_thousand_commits() {
    let mut f = Fixture::empty();
    commit_as(&mut f, Some("Old Timer <old@example.com>"), "old");
    fast_commits(&mut f, 1_999, |i| {
        format!("Author {} <a{}@example.com>", i % 51, i % 51).into_bytes()
    });
    let emails = author_emails(&f);
    // 51 authors and the old one: fifty, the most commits first, then the newest.
    assert_eq!(emails.len(), 50);
    assert!(
        !emails.contains(&"old@example.com".to_owned()),
        "{emails:?}"
    );
    assert!(emails.contains(&"a0@example.com".to_owned()), "{emails:?}");
    // Past 2,000 commits back, an author is not counted.
    let mut f = Fixture::empty();
    commit_as(&mut f, Some("Old Timer <old@example.com>"), "old");
    fast_commits(&mut f, 1_999, |_| b"Ana Ruiz <ana@example.com>".to_vec());
    assert_eq!(author_emails(&f), ["ana@example.com", "old@example.com"]);
    fast_commits(&mut f, 1, |_| b"Ana Ruiz <ana@example.com>".to_vec());
    assert_eq!(author_emails(&f), ["ana@example.com"]);
}

#[test]
fn a_commit_that_cannot_be_read_ends_its_line() {
    let mut f = Fixture::empty();
    commit_as(&mut f, None, "fix: oldest");
    commit_as(&mut f, Some("Ana Ruiz <ana@example.com>"), "feat: lost");
    commit_as(&mut f, None, "fix: newest");
    f.delete_object("HEAD~1");
    assert_eq!(messages(&f).1, ["fix: newest"]);
    assert_eq!(author_emails(&f), Vec::<String>::new());
}

#[test]
fn a_commit_libgit2_cannot_parse_ends_its_line_where_git_log_goes_on() {
    let mut f = Fixture::empty();
    commit_as(&mut f, None, "fix: first");
    // An author date git reads as 0 (`git fsck` calls it badDate) and libgit2 refuses.
    commit_bytes(
        &mut f,
        b"Fixture <fixture@example.com>",
        Some("notadate +0000"),
        b"",
        "fix: bad date",
    );
    commit_as(&mut f, None, "fix: after");
    assert_eq!(
        f.git(&["log", "--format=%s"]).lines().collect::<Vec<_>>(),
        ["fix: after", "fix: bad date", "fix: first"]
    );
    assert_eq!(messages(&f).1, ["fix: after"]);
}

#[test]
fn a_shallow_clone_reads_to_its_edge_then_past_it_once_deepened() {
    let mut f = Fixture::empty();
    commit_as(&mut f, None, "fix: one");
    commit_as(&mut f, None, "fix: two");
    commit_as(&mut f, None, "fix: three");
    let clone = f.sibling("shallow");
    let clone_str = clone.to_str().expect("utf-8 temp path");
    let root = f.root.to_str().expect("utf-8 temp path");
    f.git(&["clone", "-q", "--no-local", "--depth", "1", root, clone_str]);
    let e = Git2Engine::open(&clone).expect("open the clone");
    let read = |e: &Git2Engine| -> Vec<String> {
        e.recent_messages(Some(USER), &Cancel::never())
            .expect("recent messages")
            .messages
            .into_iter()
            .map(|m| m.message)
            .collect()
    };
    assert_eq!(read(&e), ["fix: three"]);
    f.git_in(&clone, &["fetch", "-q", "--unshallow"]);
    // The same engine, after the history grew under it.
    assert_eq!(read(&e), ["fix: three", "fix: two", "fix: one"]);
}

#[test]
fn a_message_the_box_cannot_take_is_left_out() {
    let mut f = Fixture::empty();
    commit_as(&mut f, None, "fix: kept");
    commit_file(
        &mut f,
        &["-c", "i18n.commitEncoding=latin1"],
        b"fix: caf\xe9\n",
    );
    let mut big = b"fix: big\n\n".to_vec();
    big.resize(64 * 1024 + 1, b'x');
    commit_file(&mut f, &[], &big);
    commit_file(&mut f, &[], b"\n  \nfix: after blank lines\n\n");
    assert_eq!(messages(&f).1, ["fix: after blank lines", "fix: kept"]);
}

#[test]
fn the_mailmap_matches_emails_without_case() {
    let mut f = Fixture::empty();
    commit_as(&mut f, Some("Ana R. <ana.ruiz@old.example>"), "a1");
    commit_as(&mut f, Some("Ana R. <Ana.Ruiz@Old.Example>"), "a2");
    commit_as(&mut f, Some("Bob <bob@old.example>"), "b1");
    f.write(
        ".mailmap",
        "Ana Ruiz <ana@example.com> <ana.ruiz@old.example>\n<bob@example.com> <BOB@OLD.EXAMPLE>\n",
    );
    assert_eq!(
        authors(&f),
        owned(&[
            ("Ana Ruiz", "ana@example.com", 2),
            ("Bob", "bob@example.com", 1)
        ])
    );
}

#[test]
fn the_users_old_address_maps_without_case() {
    let mut f = Fixture::empty();
    commit_as(
        &mut f,
        Some("Fixture <fixture@old.example>"),
        "fix: from before",
    );
    commit_as(&mut f, Some("Ana Ruiz <ana@example.com>"), "feat: hers");
    f.write(
        ".mailmap",
        "Fixture <fixture@example.com> <Fixture@Old.Example>\n",
    );
    assert_eq!(messages(&f).1, ["fix: from before"]);
    assert_eq!(authors(&f), owned(&[("Ana Ruiz", "ana@example.com", 1)]));
}

#[test]
fn the_mailmap_matches_names_without_case() {
    let mut f = Fixture::empty();
    commit_as(&mut f, Some("Dan Old <dan@old.example>"), "d1");
    commit_as(&mut f, Some("dan old <dan@old.example>"), "d2");
    commit_as(&mut f, Some("Daniel <dan@old.example>"), "d3");
    f.write(
        ".mailmap",
        "Dan Proper <dan@example.com> Dan Old <dan@old.example>\n",
    );
    assert_eq!(
        authors(&f),
        owned(&[
            ("Dan Proper", "dan@example.com", 2),
            ("Daniel", "dan@old.example", 1)
        ])
    );
}

#[test]
fn the_mailmap_merges_the_lines_of_one_address() {
    let mut f = Fixture::empty();
    commit_as(&mut f, Some("erin <erin@old.example>"), "e1");
    commit_as(&mut f, Some("fay <fay@old.example>"), "f1");
    f.write(
        ".mailmap",
        "<erin@example.com> <erin@old.example>\nErin Proper <erin@old.example>\nFay Proper <fay@old.example>\n<fay@example.com> <fay@old.example>\n",
    );
    assert_eq!(
        authors(&f),
        owned(&[
            ("Fay Proper", "fay@example.com", 1),
            ("Erin Proper", "erin@example.com", 1)
        ])
    );
    // Across sources too: `mailmap.file`, read after `.mailmap`, names Erin; the email stays.
    let file = f.sibling("team.mailmap");
    std::fs::write(&file, "Erin Team <erin@old.example>\n").expect("write mailmap file");
    f.git(&[
        "config",
        "mailmap.file",
        file.to_str().expect("utf-8 temp path"),
    ]);
    assert_eq!(
        authors(&f),
        owned(&[
            ("Fay Proper", "fay@example.com", 1),
            ("Erin Team", "erin@example.com", 1)
        ])
    );
}

#[test]
fn a_mailmap_file_alone_maps_too() {
    // No `.mailmap` in the working tree: the configured file is read all the same.
    let mut f = Fixture::empty();
    commit_as(&mut f, Some("Gil <gil@old.example>"), "g1");
    let file = f.sibling("team.mailmap");
    std::fs::write(&file, "Gil Proper <gil@example.com> <gil@old.example>\n")
        .expect("write mailmap file");
    f.git(&[
        "config",
        "mailmap.file",
        file.to_str().expect("utf-8 temp path"),
    ]);
    assert_eq!(authors(&f), owned(&[("Gil Proper", "gil@example.com", 1)]));
}

#[test]
fn a_mailmap_line_with_trailing_text_still_maps() {
    let mut f = Fixture::empty();
    commit_as(&mut f, Some("Hal <hal@old.example>"), "h1");
    f.write(
        ".mailmap",
        "Hal Proper <hal@example.com> <hal@old.example> moved\n",
    );
    assert_eq!(authors(&f), owned(&[("Hal Proper", "hal@example.com", 1)]));
}

#[test]
fn a_name_only_entry_names_the_author() {
    let mut f = Fixture::empty();
    commit_as(&mut f, Some("carla <carla@example.com>"), "c1");
    f.write(".mailmap", "Carla Proper <carla@example.com>\n");
    assert_eq!(
        authors(&f),
        owned(&[("Carla Proper", "carla@example.com", 1)])
    );
}

#[test]
fn an_author_without_a_name_is_mapped() {
    let mut f = Fixture::empty();
    commit_as(&mut f, Some("Ana Ruiz <ana@example.com>"), "feat: hers");
    commit_bytes(&mut f, b" <ivy@old.example>", None, b"", "ivy");
    f.write(".mailmap", "<ivy@example.com> <ivy@old.example>\n");
    assert_eq!(
        authors(&f),
        owned(&[
            ("", "ivy@example.com", 1),
            ("Ana Ruiz", "ana@example.com", 1)
        ])
    );
}

#[test]
fn an_author_reads_as_the_commit_stores_it() {
    let mut f = Fixture::empty();
    commit_as(&mut f, Some("Ana Ruiz <ana@example.com>"), "feat: hers");
    commit_bytes(
        &mut f,
        b"\"Kipp N. Davis\" <kipp@old.example>",
        None,
        b"",
        "k1",
    );
    commit_bytes(&mut f, b"Doe, John, <doe@example.com>", None, b"", "d1");
    f.write(
        ".mailmap",
        "Kipp Davis <kipp@example.com> \"Kipp N. Davis\" <kipp@old.example>\n",
    );
    assert_eq!(
        authors(&f),
        owned(&[
            ("Doe, John,", "doe@example.com", 1),
            ("Kipp Davis", "kipp@example.com", 1),
            ("Ana Ruiz", "ana@example.com", 1),
        ])
    );
}

#[test]
fn an_empty_email_maps_as_git_maps_it() {
    let mut f = Fixture::empty();
    commit_as(&mut f, Some("Ana Ruiz <ana@example.com>"), "feat: hers");
    commit_bytes(&mut f, b"Empty Mail <>", None, b"", "e1");
    f.write(
        ".mailmap",
        "Proper Empty <empty@example.com> Empty Mail <>\n",
    );
    assert_eq!(
        authors(&f),
        owned(&[
            ("Proper Empty", "empty@example.com", 1),
            ("Ana Ruiz", "ana@example.com", 1)
        ])
    );
}

#[test]
fn a_latin1_author_maps_by_the_name_git_reencodes() {
    let mut f = Fixture::empty();
    commit_as(&mut f, Some("Ana Ruiz <ana@example.com>"), "feat: hers");
    commit_bytes(
        &mut f,
        b"Jos\xe9 Old <jose@old.example>",
        None,
        b"encoding ISO-8859-1\n",
        "j1",
    );
    // The mailmap is UTF-8; git re-encodes the commit before it maps the name.
    f.write(
        ".mailmap",
        "Jos\u{e9} Proper <jose@example.com> Jos\u{e9} Old <jose@old.example>\n",
    );
    assert_eq!(
        authors(&f),
        owned(&[
            ("Jos\u{e9} Proper", "jose@example.com", 1),
            ("Ana Ruiz", "ana@example.com", 1)
        ])
    );
}

#[test]
fn a_name_that_is_not_utf8_maps_by_its_bytes() {
    let mut f = Fixture::empty();
    commit_as(&mut f, Some("Ana Ruiz <ana@example.com>"), "feat: hers");
    commit_bytes(&mut f, b"Jos\xe9 Raw <raw@old.example>", None, b"", "r1");
    std::fs::write(
        f.root.join(".mailmap"),
        b"Jose Raw <raw@example.com> Jos\xe9 Raw <raw@old.example>\n",
    )
    .expect("write mailmap");
    assert_eq!(
        authors(&f),
        owned(&[
            ("Jose Raw", "raw@example.com", 1),
            ("Ana Ruiz", "ana@example.com", 1)
        ])
    );
    // Without a mailmap entry, its bytes read with the ones that are not UTF-8 replaced.
    fast_commits(&mut f, 1, |_| b"Jos\xe9 <jose@example.com>".to_vec());
    assert_eq!(authors(&f)[0].0, "Jos\u{FFFD}");
}

#[test]
fn an_email_with_spaces_in_its_brackets_is_not_mapped() {
    let mut f = Fixture::empty();
    commit_as(&mut f, Some("Ana Ruiz <ana@example.com>"), "feat: hers");
    commit_bytes(&mut f, b"Spaced < sp@old.example >", None, b"", "s1");
    // git keeps the spaces of the stored email, so this entry does not match it.
    f.write(
        ".mailmap",
        "Spaced Proper <sp@example.com> <sp@old.example>\n",
    );
    assert_eq!(
        authors(&f),
        owned(&[
            ("Spaced", " sp@old.example ", 1),
            ("Ana Ruiz", "ana@example.com", 1)
        ])
    );
}
