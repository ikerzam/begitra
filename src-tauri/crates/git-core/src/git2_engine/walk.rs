//! Paged commit walk with lane layout.
//!
//! A walk handle owns its own libgit2 repository, opened again from the engine's root so that no
//! libgit2 object borrows the engine, and keeps the frontier, the bookkeeping maps and the lane
//! layout between pages. Paging is built on plain commit lookups and a priority queue rather
//! than `git2::Revwalk`, which can neither resume nor live next to its repository in one struct.
//!
//! Orders (see [`WalkOrder`]):
//! - [`WalkOrder::Lazy`]: a max-heap on (commit time, insertion order) seeded with the scope's
//!   tips; pop, emit, queue the parents not seen yet. The first page reads only what it shows
//!   plus the parents it queues. This is the order of plain `git log`.
//! - [`WalkOrder::DateTopo`]: the order of `git log --date-order`, which
//!   `git log --topo-order --date-order` also selects because the last flag wins. A pre-walk
//!   over the whole scope counts, per commit, how many children it has in the scope; then the
//!   same heap is seeded with the childless commits and a parent is queued only once its last
//!   child was shown. The pre-walk runs in the first `next_page`, not in `start`, so its errors
//!   surface like every other.
//!
//! Ties in the heap go to the commit inserted first, like git's `prio_queue`; seeds enter in
//! ref name order with `HEAD` last, the order `git log --all` feeds its pending list.
//!
//! A `Range` scope takes its members from libgit2's revwalk (`push` the tips, `hide` the
//! excluded revision) before the first page: its limit pass stops once every pending commit is
//! older than the hidden frontier, so the cost is the range's size plus git's slop, never the
//! excluded history. That pass runs under the operation's timeout but cannot be interrupted by
//! `Cancel`; every page after it can.
//!
//! When a commit cannot be read, the page in progress is returned with `done` set and the
//! [`GitError::CorruptObject`] is kept for the following call; when nothing was read yet the
//! error is returned right away. Cancellation is checked before every page and every
//! [`CANCEL_EVERY`] commits, inside the pre-walk too.

use std::cmp::Reverse;
use std::collections::hash_map::Entry as MapEntry;
use std::collections::{BinaryHeap, HashMap, HashSet};

use git2::{ErrorCode, Oid, ReferenceType, Repository};

use super::filter::Matcher;
use super::Git2Engine;
use crate::engine::{Cancel, CommitWalk};
use crate::error::{GitError, GitResult};
use crate::graph::LaneLayout;
use crate::types::{CommitNode, Page, Signature, WalkOptions, WalkOrder, WalkScope};

/// Largest page a walk produces; [`WalkOptions::page_size`] is clamped to `1..=MAX_PAGE_SIZE`.
pub(super) const MAX_PAGE_SIZE: usize = 500;

/// Commits read between two cancellation checks.
const CANCEL_EVERY: usize = 100;

/// Starts a walk; see [`crate::engine::GitEngine::walk`].
///
/// The scope is resolved and the ref decorations are loaded here, so an unknown revision fails
/// at once with [`GitError::RefNotFound`]; everything that reads history waits for the first
/// page.
#[tracing::instrument(
    level = "debug",
    skip_all,
    fields(order = ?options.order, page_size = options.page_size)
)]
pub(super) fn start(
    engine: &Git2Engine,
    scope: &WalkScope,
    options: &WalkOptions,
    cancel: &Cancel,
) -> GitResult<Box<dyn CommitWalk>> {
    let repo = engine.with_repo(super::reopen)?;
    let refs = load_refs(&repo, cancel)?;
    let head = head_commit(&repo)?;
    let (seeds, exclude) = resolve_scope(&repo, scope, &refs, head)?;
    let decorations = decorations(&refs, head);
    let filter = options
        .filter
        .as_ref()
        .filter(|filter| filter.is_active())
        .map(Matcher::new);
    Ok(Box::new(Walk::new(
        repo,
        options.order,
        usize::try_from(options.page_size)
            .unwrap_or(MAX_PAGE_SIZE)
            .clamp(1, MAX_PAGE_SIZE),
        filter,
        seeds,
        exclude,
        decorations,
    )))
}

/// A ref that points at a commit, as the walk sees it.
struct RefTarget {
    /// Full name, `refs/heads/main`.
    name: String,
    /// The commit the ref peels to.
    commit: Oid,
    /// Short name shown on the commit; `None` for refs the graph does not decorate: symbolic
    /// refs such as a remote `HEAD`, and refs outside heads, remotes, tags and the stash.
    label: Option<String>,
}

/// A queued commit: newest commit time first, earliest insertion first among equal times.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct QueueEntry {
    time: i64,
    seq: Reverse<u64>,
    oid: Oid,
}

/// A paged walk in progress; see the module docs.
struct Walk {
    repo: Repository,
    order: WalkOrder,
    page_size: usize,
    /// Commits kept; with a filter the layout is flat and never computed.
    filter: Option<Matcher>,
    /// Commits the scope starts from, in insertion order, without duplicates.
    seeds: Vec<Oid>,
    /// Revision whose ancestry is left out (`Range` scope).
    exclude: Option<Oid>,
    /// Short ref names per commit, `HEAD` first.
    decorations: HashMap<Oid, Vec<String>>,
    /// Whether a page was requested already (the seeds are queued, the pre-walk ran).
    started: bool,
    /// Whether no more commits will be produced.
    finished: bool,
    /// Error kept for the call after a page that ended on an unreadable object.
    pending_error: Option<GitError>,
    heap: BinaryHeap<QueueEntry>,
    next_seq: u64,
    /// The members of the range, once prepared; a parent outside is never queued or drawn.
    members: Option<HashSet<Oid>>,
    /// Lazy order: every commit queued so far, `true` once shown.
    seen: HashMap<Oid, bool>,
    /// Date-topo order: children still to show, per commit not shown yet.
    waiting_children: HashMap<Oid, u32>,
    layout: LaneLayout,
}

impl Walk {
    fn new(
        repo: Repository,
        order: WalkOrder,
        page_size: usize,
        filter: Option<Matcher>,
        seeds: Vec<Oid>,
        exclude: Option<Oid>,
        decorations: HashMap<Oid, Vec<String>>,
    ) -> Self {
        Self {
            repo,
            order,
            page_size,
            filter,
            seeds,
            exclude,
            decorations,
            started: false,
            finished: false,
            pending_error: None,
            heap: BinaryHeap::new(),
            next_seq: 0,
            members: None,
            seen: HashMap::new(),
            waiting_children: HashMap::new(),
            layout: LaneLayout::new(),
        }
    }

    /// Whether `oid` lies outside the range (never, without an excluded revision).
    fn outside(&self, oid: Oid) -> bool {
        self.members
            .as_ref()
            .is_some_and(|members| !members.contains(&oid))
    }

    /// Queues the seeds; in date-topo order the pre-walk runs first.
    fn prepare(&mut self, cancel: &Cancel) -> GitResult<()> {
        if let Some(exclude) = self.exclude {
            cancel.check()?;
            let (members, _) = range_members(&self.repo, &self.seeds, exclude, None)?;
            self.members = Some(members);
        }
        let seeds: Vec<Oid> = self
            .seeds
            .iter()
            .copied()
            .filter(|seed| !self.outside(*seed))
            .collect();
        match self.order {
            WalkOrder::Lazy => {
                for seed in seeds {
                    if let MapEntry::Vacant(entry) = self.seen.entry(seed) {
                        entry.insert(false);
                        self.queue(seed)?;
                    }
                }
            }
            WalkOrder::DateTopo => {
                self.count_children(&seeds, cancel)?;
                for seed in seeds {
                    if self.waiting_children.get(&seed) == Some(&0) {
                        self.queue(seed)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// The date-topo pre-walk: visits every commit of the scope once and counts, per commit,
    /// the children it has in the scope.
    fn count_children(&mut self, seeds: &[Oid], cancel: &Cancel) -> GitResult<()> {
        let mut stack = Vec::new();
        for seed in seeds {
            if let MapEntry::Vacant(entry) = self.waiting_children.entry(*seed) {
                entry.insert(0);
                stack.push(*seed);
            }
        }
        let mut visited = 0usize;
        while let Some(oid) = stack.pop() {
            visited += 1;
            if visited.is_multiple_of(CANCEL_EVERY) {
                cancel.check()?;
            }
            let commit = self
                .repo
                .find_commit(oid)
                .map_err(|error| GitError::object(&oid.to_string(), error))?;
            for parent in commit.parent_ids() {
                if self.outside(parent) {
                    continue;
                }
                match self.waiting_children.entry(parent) {
                    MapEntry::Occupied(mut entry) => *entry.get_mut() += 1,
                    MapEntry::Vacant(entry) => {
                        entry.insert(1);
                        stack.push(parent);
                    }
                }
            }
        }
        Ok(())
    }

    /// Reads `oid` for its commit time and queues it.
    fn queue(&mut self, oid: Oid) -> GitResult<()> {
        let time = self
            .repo
            .find_commit(oid)
            .map_err(|error| GitError::object(&oid.to_string(), error))?
            .time()
            .seconds();
        self.heap.push(QueueEntry {
            time,
            seq: Reverse(self.next_seq),
            oid,
        });
        self.next_seq += 1;
        Ok(())
    }

    /// Reads `oid`, marks it shown, lays out its row and returns the node together with the
    /// parents to queue; their lookups happen afterwards, so an unreadable parent never loses
    /// the row that was read.
    /// Reads `oid`, decides whether the filter keeps it, and queues its parents. The row is
    /// built only for a kept commit; under a filter it is flat and the lane layout is skipped.
    fn emit(&mut self, oid: Oid) -> GitResult<(Option<CommitNode>, Vec<Oid>)> {
        let commit = self
            .repo
            .find_commit(oid)
            .map_err(|error| GitError::object(&oid.to_string(), error))?;
        let kept = self
            .filter
            .as_ref()
            .is_none_or(|matcher| matcher.matches(&commit));
        let parent_ids: Vec<Oid> = commit.parent_ids().collect();
        let row = kept.then(|| {
            let (subject, body) = split_message(commit.message_raw_bytes());
            (
                signature(&commit.author()),
                signature(&commit.committer()),
                subject,
                body,
            )
        });
        drop(commit);

        match self.order {
            WalkOrder::Lazy => {
                self.seen.insert(oid, true);
            }
            WalkOrder::DateTopo => {
                self.waiting_children.remove(&oid);
            }
        }
        let mut to_queue = Vec::new();
        let mut ahead = Vec::with_capacity(parent_ids.len());
        for (index, parent) in parent_ids.iter().enumerate() {
            if self.outside(*parent) {
                continue;
            }
            let drawable = match self.order {
                WalkOrder::Lazy => match self.seen.entry(*parent) {
                    MapEntry::Occupied(entry) => !*entry.get(),
                    MapEntry::Vacant(entry) => {
                        entry.insert(false);
                        to_queue.push(*parent);
                        true
                    }
                },
                WalkOrder::DateTopo => match self.waiting_children.get_mut(parent) {
                    None => false,
                    Some(children) => {
                        *children = children.saturating_sub(1);
                        if *children == 0 {
                            to_queue.push(*parent);
                        }
                        true
                    }
                },
            };
            if drawable {
                ahead.push(index);
            }
        }

        let Some((author, committer, subject, body)) = row else {
            return Ok((None, to_queue));
        };
        let hash = oid.to_string();
        let parents: Vec<String> = parent_ids.iter().map(Oid::to_string).collect();
        let refs = self.decorations.get(&oid).cloned().unwrap_or_default();
        let (lane, edges, overflow) = if self.filter.is_some() {
            // Lines between non-adjacent commits would not be parent edges.
            (0, Vec::new(), 0)
        } else {
            let mut drawable: Vec<&str> = Vec::with_capacity(ahead.len());
            for parent in ahead
                .iter()
                .filter_map(|&index| parents.get(index).map(String::as_str))
            {
                // libgit2 can write a commit that names a parent twice; one line leads to it.
                if !drawable.contains(&parent) {
                    drawable.push(parent);
                }
            }
            let placement = self.layout.place(&hash, &drawable);
            (placement.lane, placement.edges, placement.overflow)
        };
        let node = CommitNode {
            hash,
            parents,
            author,
            committer,
            subject,
            body,
            refs,
            lane,
            edges,
            overflow,
        };
        Ok((Some(node), to_queue))
    }

    /// Fails with [`GitError::Cancelled`], ending the walk, when cancellation was requested.
    fn checkpoint(&mut self, cancel: &Cancel) -> GitResult<()> {
        if cancel.is_cancelled() {
            self.finish();
            return Err(GitError::Cancelled);
        }
        Ok(())
    }

    /// Ends the walk and releases its working memory: later calls answer empty done pages.
    fn finish(&mut self) {
        self.finished = true;
        self.heap = BinaryHeap::new();
        self.members = None;
        self.seen = HashMap::new();
        self.waiting_children = HashMap::new();
    }

    /// Ends the walk on `error`: the commits read so far go out as the last page and the error
    /// waits for the following call; with nothing read, the error goes out now.
    fn fail(&mut self, commits: Vec<CommitNode>, error: GitError) -> GitResult<Page> {
        self.finish();
        if commits.is_empty() {
            Err(error)
        } else {
            self.pending_error = Some(error);
            Ok(Page {
                commits,
                done: true,
            })
        }
    }
}

impl CommitWalk for Walk {
    #[tracing::instrument(level = "debug", skip_all)]
    fn next_page(&mut self, cancel: &Cancel) -> GitResult<Page> {
        if let Some(error) = self.pending_error.take() {
            return Err(error);
        }
        if self.finished {
            return Ok(Page {
                commits: Vec::new(),
                done: true,
            });
        }
        self.checkpoint(cancel)?;
        if !self.started {
            self.started = true;
            if let Err(error) = self.prepare(cancel) {
                return self.fail(Vec::new(), error);
            }
        }

        let mut commits = Vec::with_capacity(self.page_size);
        let mut walked: usize = 0;
        while commits.len() < self.page_size {
            walked += 1;
            if walked.is_multiple_of(CANCEL_EVERY) {
                self.checkpoint(cancel)?;
            }
            let Some(entry) = self.heap.pop() else {
                break;
            };
            let (node, to_queue) = match self.emit(entry.oid) {
                Ok(emitted) => emitted,
                Err(error) => return self.fail(commits, error),
            };
            // Pushed before the parents are queued, so an unreadable parent still leaves
            // this row in the partial page.
            if let Some(node) = node {
                commits.push(node);
            }
            for parent in to_queue {
                if let Err(error) = self.queue(parent) {
                    return self.fail(commits, error);
                }
            }
        }
        if self.heap.is_empty() {
            self.finish();
        }
        tracing::debug!(commits = commits.len(), done = self.finished, "walk page");
        Ok(Page {
            commits,
            done: self.finished,
        })
    }
}

/// Seeds and exclusion of `scope` on `repo`, for callers that walk without the layout.
pub(super) fn scope_of(
    repo: &Repository,
    scope: &WalkScope,
    cancel: &Cancel,
) -> GitResult<(Vec<Oid>, Option<Oid>)> {
    let refs = load_refs(repo, cancel)?;
    let head = head_commit(repo)?;
    resolve_scope(repo, scope, &refs, head)
}

/// A flat node (lane 0, no edges) for `commit`, with its decorations; the CLI walk and
/// counts use it, the walker builds its own with the layout.
pub(super) fn node_of(
    commit: &git2::Commit<'_>,
    decorations: &HashMap<Oid, Vec<String>>,
) -> CommitNode {
    let oid = commit.id();
    let (subject, body) = split_message(commit.message_raw_bytes());
    CommitNode {
        hash: oid.to_string(),
        parents: commit.parent_ids().map(|p| p.to_string()).collect(),
        author: signature(&commit.author()),
        committer: signature(&commit.committer()),
        subject,
        body,
        refs: decorations.get(&oid).cloned().unwrap_or_default(),
        lane: 0,
        edges: Vec::new(),
        overflow: 0,
    }
}

/// The decoration map of `repo` (short ref names per commit, `HEAD` first).
pub(super) fn decorations_for(
    repo: &Repository,
    cancel: &Cancel,
) -> GitResult<HashMap<Oid, Vec<String>>> {
    let refs = load_refs(repo, cancel)?;
    let head = head_commit(repo)?;
    Ok(decorations(&refs, head))
}

/// Every ref under `refs/` that peels to a commit, sorted by full name.
///
/// Dangling symbolic refs and tags of trees or blobs are skipped, as `git log --all` skips
/// them; a ref whose target cannot be read fails with [`GitError::CorruptObject`].
fn load_refs(repo: &Repository, cancel: &Cancel) -> GitResult<Vec<RefTarget>> {
    let mut refs = Vec::new();
    for (index, reference) in repo.references()?.enumerate() {
        if index.is_multiple_of(CANCEL_EVERY) {
            cancel.check()?;
        }
        let reference = reference?;
        let name = String::from_utf8_lossy(reference.name_bytes()).into_owned();
        if !name.starts_with("refs/") {
            continue;
        }
        let symbolic = reference.kind() == Some(ReferenceType::Symbolic);
        let commit = match reference.peel_to_commit() {
            Ok(commit) => commit.id(),
            // Annotated tags on trees or blobs fail with `Peel`, lightweight ones with
            // `InvalidSpec`; `git log --all` skips both kinds.
            Err(error)
                if symbolic || matches!(error.code(), ErrorCode::Peel | ErrorCode::InvalidSpec) =>
            {
                continue
            }
            // A ref whose object is missing from the store is broken; `git log --all` warns
            // and goes on without it.
            Err(error)
                if error.code() == ErrorCode::NotFound
                    && reference
                        .target()
                        .is_some_and(|oid| super::object_missing(repo, oid)) =>
            {
                tracing::warn!(reference = %name, "ignoring a broken ref: its object is missing");
                continue;
            }
            Err(error) => return Err(super::reference_error(repo, reference.target(), error)),
        };
        let label = if symbolic { None } else { label(&name) };
        refs.push(RefTarget {
            name,
            commit,
            label,
        });
    }
    refs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(refs)
}

/// The commit `HEAD` points at; `None` on an unborn branch.
fn head_commit(repo: &Repository) -> GitResult<Option<Oid>> {
    let head = match repo.head() {
        Ok(head) => head,
        Err(error) if matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };
    let commit = head
        .peel_to_commit()
        .map_err(|error| super::reference_error(repo, head.target(), error))?;
    Ok(Some(commit.id()))
}

/// Seeds of the scope in insertion order without duplicates, and the revision to exclude.
fn resolve_scope(
    repo: &Repository,
    scope: &WalkScope,
    refs: &[RefTarget],
    head: Option<Oid>,
) -> GitResult<(Vec<Oid>, Option<Oid>)> {
    match scope {
        WalkScope::All => {
            let mut seeds = Vec::with_capacity(refs.len() + 1);
            let mut unique = HashSet::with_capacity(refs.len() + 1);
            for commit in refs.iter().map(|target| target.commit).chain(head) {
                if unique.insert(commit) {
                    seeds.push(commit);
                }
            }
            Ok((seeds, None))
        }
        WalkScope::Ref { name } => Ok((vec![resolve_commit(repo, name)?], None)),
        WalkScope::Range { exclude, include } => {
            let tip = resolve_commit(repo, include)?;
            let base = resolve_commit(repo, exclude)?;
            Ok((vec![tip], Some(base)))
        }
    }
}

/// Resolves `spec` as `git rev-parse` would and peels it to a commit.
fn resolve_commit(repo: &Repository, spec: &str) -> GitResult<Oid> {
    super::resolve_commit(repo, spec)
}

/// The commits of `exclude..include` from libgit2's revwalk (`push` the tips, `hide` the
/// excluded revision), whose limit pass stops once every pending commit is older than the
/// hidden frontier: the cost is the range's size plus git's slop, never the history. With
/// `cap`, at most `cap` members are collected and the flag says whether more remained.
pub(super) fn range_members(
    repo: &Repository,
    include: &[Oid],
    exclude: Oid,
    cap: Option<usize>,
) -> GitResult<(HashSet<Oid>, bool)> {
    let mut walk = repo.revwalk()?;
    walk.set_sorting(git2::Sort::NONE)?;
    for oid in include {
        walk.push(*oid)?;
    }
    walk.hide(exclude)?;
    let mut members = HashSet::new();
    for next in walk {
        let oid = next.map_err(|error| {
            let hash = super::diff::hash_in_message(error.message())
                .unwrap_or_else(|| exclude.to_string());
            GitError::object(&hash, error)
        })?;
        if cap.is_some_and(|cap| members.len() >= cap) {
            return Ok((members, true));
        }
        members.insert(oid);
    }
    Ok((members, false))
}

/// Short ref names per commit: `HEAD` first, then the refs in name order.
fn decorations(refs: &[RefTarget], head: Option<Oid>) -> HashMap<Oid, Vec<String>> {
    let mut map: HashMap<Oid, Vec<String>> = HashMap::new();
    if let Some(head) = head {
        map.entry(head).or_default().push("HEAD".to_owned());
    }
    for target in refs {
        if let Some(label) = &target.label {
            map.entry(target.commit).or_default().push(label.clone());
        }
    }
    map
}

/// Short name of a decorated ref; `None` for refs the graph does not show.
fn label(name: &str) -> Option<String> {
    if name == "refs/stash" {
        return Some("stash@{0}".to_owned());
    }
    ["refs/heads/", "refs/remotes/", "refs/tags/"]
        .iter()
        .find_map(|prefix| name.strip_prefix(prefix))
        .map(str::to_owned)
}

fn signature(signature: &git2::Signature<'_>) -> Signature {
    let when = signature.when();
    Signature {
        name: String::from_utf8_lossy(signature.name_bytes()).into_owned(),
        email: String::from_utf8_lossy(signature.email_bytes()).into_owned(),
        time: when.seconds(),
        offset_minutes: when.offset_minutes(),
    }
}

/// Splits a raw commit message into subject and body the way `git log --format=%s` and `%b`
/// do: leading blank lines are skipped; the subject is the first paragraph with each line's
/// trailing whitespace removed and the lines joined by one space; the body is what follows the
/// blank lines after that paragraph, with its trailing newlines removed.
pub(super) fn split_message(raw: &[u8]) -> (String, String) {
    let text = String::from_utf8_lossy(raw);
    let lines: Vec<&str> = text.split('\n').collect();
    let mut index = 0;
    while lines.get(index).is_some_and(|line| is_blank(line)) {
        index += 1;
    }
    let mut subject = String::new();
    while let Some(line) = lines.get(index) {
        if is_blank(line) {
            break;
        }
        if !subject.is_empty() {
            subject.push(' ');
        }
        subject.push_str(line.trim_end_matches(is_git_space));
        index += 1;
    }
    while lines.get(index).is_some_and(|line| is_blank(line)) {
        index += 1;
    }
    let body = lines.get(index..).unwrap_or_default().join("\n");
    (subject, body.trim_end_matches('\n').to_owned())
}

/// Whitespace as git's `isspace` sees it.
fn is_git_space(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r')
}

fn is_blank(line: &str) -> bool {
    line.chars().all(is_git_space)
}

#[cfg(test)]
mod tests {
    use super::{label, split_message};

    #[test]
    fn subject_joins_the_first_paragraph_and_trims_line_ends() {
        assert_eq!(
            split_message(b"line one  \nline two\t\n\nbody line\nmore\n"),
            ("line one line two".to_owned(), "body line\nmore".to_owned())
        );
    }

    #[test]
    fn blank_lines_around_the_subject_are_skipped() {
        assert_eq!(
            split_message(b"\n\n  \nsubject\n   \n\t\nbody\n\n\n"),
            ("subject".to_owned(), "body".to_owned())
        );
    }

    #[test]
    fn messages_without_a_body() {
        assert_eq!(
            split_message(b"subject"),
            ("subject".to_owned(), String::new())
        );
        assert_eq!(
            split_message(b"subject\n"),
            ("subject".to_owned(), String::new())
        );
        assert_eq!(split_message(b""), (String::new(), String::new()));
    }

    #[test]
    fn body_keeps_its_inner_blank_lines() {
        assert_eq!(
            split_message(b"s\n\nfirst\n\nsecond\n"),
            ("s".to_owned(), "first\n\nsecond".to_owned())
        );
    }

    #[test]
    fn labels_follow_the_short_ref_names() {
        assert_eq!(label("refs/heads/main").as_deref(), Some("main"));
        assert_eq!(
            label("refs/remotes/origin/main").as_deref(),
            Some("origin/main")
        );
        assert_eq!(label("refs/tags/v1").as_deref(), Some("v1"));
        assert_eq!(label("refs/stash").as_deref(), Some("stash@{0}"));
        assert_eq!(label("refs/notes/commits"), None);
    }
}
