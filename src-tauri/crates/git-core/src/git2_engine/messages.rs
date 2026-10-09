//! What the commit box offers to write: the user's recent commit messages and the people who
//! wrote the recent commits. The user is the author the box shows (`git var GIT_AUTHOR_IDENT`,
//! read by [`crate::engine::GitEngine::commit_context`]); the commits are walked by libgit2 on a
//! handle of their own and named through git's own mailmap (`git check-mailmap --stdin`), as
//! `git log --use-mailmap` and `git shortlog` name them.

use std::cmp::{Ordering, Reverse};
use std::collections::{BinaryHeap, HashMap, HashSet};

use git2::{Commit, ErrorCode, Oid, Repository};

use super::staging::{judged, root, MAX_BOX_TEXT_BYTES};
use super::Git2Engine;
use crate::cli::run_git_with_input;
use crate::engine::Cancel;
use crate::error::{GitError, GitResult};
use crate::types::{RecentAuthor, RecentMessage, RecentMessages};

/// How far back the user's messages are looked for.
const MESSAGES_WALKED: usize = 500;
/// How many distinct messages the commit box lists.
const MESSAGES_KEPT: usize = 10;
/// How far back the authors are counted.
const AUTHORS_WALKED: usize = 2_000;
/// How many authors the commit box lists.
const AUTHORS_KEPT: usize = 50;
/// The commits walked between two looks at the cancel.
const CANCEL_EVERY: usize = 100;
/// The branches read between two looks at the cancel, while the walk gathers its tips.
const TIPS_BETWEEN_CANCELS: usize = 500;

/// See [`crate::engine::GitEngine::recent_messages`].
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn recent_messages(
    engine: &Git2Engine,
    author: Option<&str>,
    cancel: &Cancel,
) -> GitResult<RecentMessages> {
    let Some(user) = author.and_then(contact_of_ident) else {
        return Ok(RecentMessages {
            identity: false,
            messages: Vec::new(),
        });
    };
    let repo = engine.with_repo(super::reopen)?;
    let mut walked = Vec::new();
    let walk = Newest::new(&repo, head_commit(&repo));
    for (at, commit) in walk.take(MESSAGES_WALKED).enumerate() {
        if at % CANCEL_EVERY == 0 {
            cancel.check()?;
        }
        walked.push((contact_of(&commit), commit));
    }
    let mut messages: Vec<RecentMessage> = Vec::with_capacity(MESSAGES_KEPT);
    if walked.is_empty() {
        return Ok(RecentMessages {
            identity: true,
            messages,
        });
    }
    let contacts = walked.iter().map(|(contact, _)| contact);
    let people = mailmapped(
        engine,
        &repo,
        std::iter::once(&user).chain(contacts),
        cancel,
    )?;
    let user = people.email(&user);
    for (contact, commit) in &walked {
        if !people.email(contact).eq_ignore_ascii_case(user) {
            continue;
        }
        // A message longer than the box takes, or one that is not UTF-8, is not offered.
        let bytes = commit.message_bytes();
        if bytes.len() > MAX_BOX_TEXT_BYTES {
            continue;
        }
        let Ok(message) = std::str::from_utf8(bytes) else {
            continue;
        };
        let message = trimmed(message);
        if message.is_empty() || messages.iter().any(|kept| kept.message == message) {
            continue;
        }
        messages.push(RecentMessage {
            hash: commit.id().to_string(),
            message: message.to_owned(),
            time: commit.author().when().seconds(),
        });
        if messages.len() == MESSAGES_KEPT {
            break;
        }
    }
    Ok(RecentMessages {
        identity: true,
        messages,
    })
}

/// See [`crate::engine::GitEngine::recent_authors`].
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn recent_authors(
    engine: &Git2Engine,
    author: Option<&str>,
    cancel: &Cancel,
) -> GitResult<Vec<RecentAuthor>> {
    let user = author.and_then(contact_of_ident);
    let repo = engine.with_repo(super::reopen)?;
    let tips = tips(&repo, cancel)?;
    cancel.check()?;
    let mut walked: Vec<(Vec<u8>, i64)> = Vec::new();
    for (at, commit) in Newest::new(&repo, tips).take(AUTHORS_WALKED).enumerate() {
        if at % CANCEL_EVERY == 0 {
            cancel.check()?;
        }
        walked.push((contact_of(&commit), commit.author().when().seconds()));
    }
    if walked.is_empty() {
        return Ok(Vec::new());
    }
    let contacts = walked.iter().map(|(contact, _)| contact);
    let people = mailmapped(engine, &repo, user.iter().chain(contacts), cancel)?;
    let user = user.as_deref().map(|user| people.email(user));
    // Keyed by the email in ASCII lowercase, as git compares emails.
    let mut authors: HashMap<Vec<u8>, RecentAuthor> = HashMap::new();
    let mut key = Vec::new();
    for (contact, time) in &walked {
        let (name, email) = people.of(contact);
        let users = user.is_some_and(|user| email.eq_ignore_ascii_case(user));
        if email.is_empty() || users {
            continue;
        }
        key.clear();
        key.extend_from_slice(email);
        key.make_ascii_lowercase();
        if let Some(known) = authors.get_mut(&key) {
            known.commits += 1;
            continue;
        }
        // The walk goes newest first: the first commit of an author names them.
        authors.insert(
            key.clone(),
            RecentAuthor {
                name: String::from_utf8_lossy(name).into_owned(),
                email: String::from_utf8_lossy(email).into_owned(),
                commits: 1,
                time: *time,
            },
        );
    }
    let mut list: Vec<RecentAuthor> = authors.into_values().collect();
    list.sort_by(|a, b| {
        b.commits
            .cmp(&a.commits)
            .then(b.time.cmp(&a.time))
            .then_with(|| a.email.cmp(&b.email))
    });
    list.truncate(AUTHORS_KEPT);
    Ok(list)
}

/// The user's `Name <email>` for the mailmap, from the author the box shows; none when it has no
/// email (git could not tell who commits, or its email is empty).
fn contact_of_ident(ident: &str) -> Option<Vec<u8>> {
    let (_, email) = split_contact(ident.as_bytes());
    if email.iter().all(u8::is_ascii_whitespace) {
        return None;
    }
    Some(ident.trim().as_bytes().to_vec())
}

/// A message as the commit box takes it: without the blank lines around it.
fn trimmed(message: &str) -> &str {
    let message = message.trim_end();
    let mut start = 0;
    for line in message.split_inclusive('\n') {
        if !line.trim().is_empty() {
            break;
        }
        start += line.len();
    }
    &message[start..]
}

/// HEAD's commit; none on an unborn branch.
fn head_commit(repo: &Repository) -> Option<Commit<'_>> {
    repo.head().ok()?.peel_to_commit().ok()
}

/// HEAD's commit, then the commit of every local and remote-tracking branch; a ref that does
/// not lead to a commit is left out.
fn tips<'r>(repo: &'r Repository, cancel: &Cancel) -> GitResult<Vec<Commit<'r>>> {
    let mut tips: Vec<Commit<'r>> = head_commit(repo).into_iter().collect();
    for glob in ["refs/heads/*", "refs/remotes/*"] {
        let Ok(references) = repo.references_glob(glob) else {
            continue;
        };
        for (at, reference) in references.flatten().enumerate() {
            if at % TIPS_BETWEEN_CANCELS == 0 {
                cancel.check()?;
            }
            if let Ok(commit) = reference.peel_to_commit() {
                tips.push(commit);
            }
        }
    }
    Ok(tips)
}

/// A commit waiting in the walk, in git's order: the newer commit time first, then the one
/// queued first.
struct Queued<'r> {
    time: i64,
    order: Reverse<u64>,
    commit: Commit<'r>,
}

impl Ord for Queued<'_> {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.time, self.order).cmp(&(other.time, other.order))
    }
}

impl PartialOrd for Queued<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for Queued<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Queued<'_> {}

/// Commits newest first from `tips`, as plain `git log` walks them: a max-heap on the commit
/// time and the order a commit was queued, seeded with the tips; each commit taken queues its
/// parents not seen yet. It reads the commits it gives and their parents only, where libgit2's
/// time-sorted revwalk walks the whole history before its first commit (seconds on a large
/// repository). A commit that cannot be read is not walked, nor what only it leads to. A
/// shallow clone's edge is the one the handle read when it opened, so the walk runs on a
/// handle opened for it.
struct Newest<'r> {
    repo: &'r Repository,
    heap: BinaryHeap<Queued<'r>>,
    seen: HashSet<Oid>,
    queued: u64,
}

impl<'r> Newest<'r> {
    fn new(repo: &'r Repository, tips: impl IntoIterator<Item = Commit<'r>>) -> Self {
        let mut walk = Self {
            repo,
            heap: BinaryHeap::new(),
            seen: HashSet::new(),
            queued: 0,
        };
        for tip in tips {
            if walk.seen.insert(tip.id()) {
                walk.push(tip);
            }
        }
        walk
    }

    fn push(&mut self, commit: Commit<'r>) {
        self.queued += 1;
        self.heap.push(Queued {
            time: commit.time().seconds(),
            order: Reverse(self.queued),
            commit,
        });
    }

    fn queue(&mut self, oid: Oid) {
        if !self.seen.insert(oid) {
            return;
        }
        match self.repo.find_commit(oid) {
            Ok(commit) => self.push(commit),
            Err(error) if error.code() == ErrorCode::NotFound => {}
            Err(error) => tracing::debug!(%oid, %error, "a commit the walk cannot read"),
        }
    }
}

impl<'r> Iterator for Newest<'r> {
    type Item = Commit<'r>;

    fn next(&mut self) -> Option<Commit<'r>> {
        let Queued { commit, .. } = self.heap.pop()?;
        for parent in commit.parent_ids() {
            self.queue(parent);
        }
        Some(commit)
    }
}

/// People after git's own mailmap, by their `Name <email>` before it.
struct People(HashMap<Vec<u8>, (Vec<u8>, Vec<u8>)>);

impl People {
    /// The name and the email of `contact` after the mailmap.
    fn of<'a>(&'a self, contact: &'a [u8]) -> (&'a [u8], &'a [u8]) {
        match self.0.get(contact) {
            Some((name, email)) => (name, email),
            None => split_contact(contact),
        }
    }

    /// The email of `contact` after the mailmap.
    fn email<'a>(&'a self, contact: &'a [u8]) -> &'a [u8] {
        self.of(contact).1
    }
}

/// Every distinct contact through git's own mailmap, `git check-mailmap --stdin`: the working
/// tree's `.mailmap`, `mailmap.blob` and `mailmap.file`, emails and names matched without case
/// and the lines of one address merged, as `git log --use-mailmap` maps them. Not libgit2's
/// mailmap, which matches with case, keeps only the last line of an address and drops a line
/// with text after its emails. A repository without a mailmap source asks git nothing.
fn mailmapped<'c>(
    engine: &Git2Engine,
    repo: &Repository,
    contacts: impl IntoIterator<Item = &'c Vec<u8>>,
    cancel: &Cancel,
) -> GitResult<People> {
    if !has_mailmap(repo) {
        return Ok(People(HashMap::new()));
    }
    let mut asked: Vec<&Vec<u8>> = Vec::new();
    let mut seen = HashSet::new();
    let mut input = Vec::new();
    for contact in contacts {
        if seen.insert(contact) {
            input.extend_from_slice(contact);
            input.push(b'\n');
            asked.push(contact);
        }
    }
    let args = ["check-mailmap", "--stdin"];
    let exit = judged(
        &args,
        run_git_with_input(root(engine), &args, input, cancel)?,
    )?;
    // One line per contact, then the empty piece after the last newline.
    let answers: Vec<&[u8]> = exit.stdout.split(|&byte| byte == b'\n').collect();
    if answers.len() != asked.len() + 1 {
        return Err(GitError::Cli {
            command: "git check-mailmap --stdin".to_owned(),
            status: exit.status,
            stderr: format!(
                "{} answers for {} people",
                answers.len().saturating_sub(1),
                asked.len()
            ),
        });
    }
    let people = asked
        .into_iter()
        .zip(answers)
        .map(|(contact, answer)| {
            let answer = answer.strip_suffix(b"\r").unwrap_or(answer);
            let (name, email) = split_contact(answer);
            (contact.clone(), (name.to_vec(), email.to_vec()))
        })
        .collect();
    Ok(People(people))
}

/// Whether git may read a mailmap here: a `.mailmap` in the working tree (git decides whether
/// it follows a link), `mailmap.file` or `mailmap.blob` in the configuration as libgit2 reads
/// it, or a bare repository's `HEAD:.mailmap`; when the configuration cannot be read, git is
/// asked. A key set only through `includeIf "hasconfig:…"` or `GIT_CONFIG_*`, which libgit2
/// does not read, is missed, and its mailmap with it.
fn has_mailmap(repo: &Repository) -> bool {
    let in_tree = repo
        .workdir()
        .is_some_and(|dir| dir.join(".mailmap").symlink_metadata().is_ok());
    if in_tree || repo.is_bare() {
        return true;
    }
    let Ok(config) = repo.config().and_then(|mut config| config.snapshot()) else {
        return true;
    };
    ["mailmap.file", "mailmap.blob"]
        .iter()
        .any(|key| config.get_entry(key).is_ok())
}

/// `Name <email>` split as git splits an ident: the name before the `<` without its trailing
/// white space, the email up to the first `>` after it; all of it a name when there is no `<`.
fn split_contact(contact: &[u8]) -> (&[u8], &[u8]) {
    let Some(open) = contact.iter().position(|&byte| byte == b'<') else {
        return (contact, &[]);
    };
    let rest = &contact[open + 1..];
    let close = rest
        .iter()
        .position(|&byte| byte == b'>')
        .unwrap_or(rest.len());
    let name = &contact[..open];
    let end = name
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map_or(0, |at| at + 1);
    (&name[..end], &rest[..close])
}

/// A commit's author as `git log` hands it to the mailmap: `Name <email>` of the author line as
/// the commit stores it (libgit2's signature trims quotes, commas, semicolons, backslashes and
/// white space off both ends), in UTF-8 when the commit says it is ISO-8859-1 (git re-encodes a
/// commit before it maps its people), its own bytes otherwise.
fn contact_of(commit: &Commit<'_>) -> Vec<u8> {
    let author = commit.author();
    let (name, email) =
        stored_author(commit).unwrap_or((author.name_bytes(), author.email_bytes()));
    let mut contact = Vec::with_capacity(name.len() + email.len() + 3);
    contact.extend_from_slice(name);
    contact.extend_from_slice(b" <");
    contact.extend_from_slice(email);
    contact.push(b'>');
    if is_latin1(commit) {
        contact
            .iter()
            .map(|&byte| char::from(byte))
            .collect::<String>()
            .into_bytes()
    } else {
        contact
    }
}

/// The name and the email of a commit's author line as stored, split as git splits an ident;
/// none when the header has no author line with an email.
fn stored_author<'c>(commit: &'c Commit<'_>) -> Option<(&'c [u8], &'c [u8])> {
    let line = commit
        .raw_header_bytes()
        .split(|&byte| byte == b'\n')
        .find_map(|line| line.strip_prefix(b"author "))?;
    let (name, email) = split_contact(line);
    line.contains(&b'<').then_some((name, email))
}

/// Whether the commit says it is written in ISO-8859-1 (its `encoding` header).
fn is_latin1(commit: &Commit<'_>) -> bool {
    commit
        .message_encoding()
        .ok()
        .flatten()
        .is_some_and(|name| {
            let name = name.to_ascii_lowercase().replace(['-', '_'], "");
            matches!(name.as_str(), "iso88591" | "latin1" | "l1")
        })
}
