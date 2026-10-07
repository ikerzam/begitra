//! The review store as an agent sees it: Begitra's index opened beside the app (never created,
//! never migrated), a repository resolved to the key the app stores it under, and the reads and
//! writes behind the tools. Everything here is synchronous (SQLite and libgit2 block); the
//! server runs it off the async runtime, resolving a folder ([`spellings`]) before it takes the
//! store's lock.

use std::path::{Path, PathBuf};

use git_core::engine::GitEngine;
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::spelling::{canonical, normalise};
use repo_index::annotations::{MAX_KEY_BYTES, MAX_NOTE_CHARS, MAX_PATH_BYTES};
use repo_index::{AnnotationKey, AnnotationKind, Index, IndexError, RepoKind, Resolution};
use schemars::JsonSchema;
use serde::Serialize;

/// Why a tool did not do what it was asked, with a stable code an agent can branch on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Failure {
    /// `index.not_found`, `index.version`, `index.busy`, `repo.not_found`, `repo.unreadable`,
    /// `review.not_found`, `note.not_found`, `note.changed`, `invalid_argument`, `op.timeout`
    /// or `internal`.
    pub code: &'static str,
    /// What happened, in a sentence.
    pub message: String,
}

impl Failure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_argument", message)
    }

    /// A failure nothing else names.
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("internal", message)
    }

    /// A call that ran past its time.
    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new("op.timeout", message)
    }
}

impl From<IndexError> for Failure {
    fn from(error: IndexError) -> Self {
        let busy = matches!(
            &error,
            IndexError::Sqlite(rusqlite::Error::SqliteFailure(failure, _))
                if matches!(
                    failure.code,
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                )
        );
        match error {
            _ if busy => Self::new(
                "index.busy",
                "Begitra's index stayed locked by another writer; try again",
            ),
            IndexError::Version { found, expected } => Self::new(
                "index.version",
                format!(
                    "Begitra's index is of another version (schema {found}, this server reads \
                     {expected}): use the begitra-mcp installed with the app"
                ),
            ),
            other => Self::internal(other.to_string()),
        }
    }
}

/// The result of a store operation.
pub type StoreResult<T> = Result<T, Failure>;

/// A repository Begitra knows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    /// Its working tree root, as `repo` takes it.
    pub path: String,
    /// Its name (the folder's).
    pub name: String,
    /// `main` for a repository, `worktree` for a linked worktree.
    pub kind: String,
    /// The projects that hold it.
    pub projects: Vec<String>,
}

/// The repositories Begitra knows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct Repositories {
    /// By path.
    pub repositories: Vec<Repository>,
}

/// A review of a repository that holds marks or notes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSummary {
    /// The review's target key: `worktree`, `index`, a commit hash, `a..b`, `a...b` or
    /// `rev..worktree`.
    pub target: String,
    /// Files the user marked reviewed as a whole.
    pub files_reviewed: u32,
    /// Hunks the user marked reviewed.
    pub hunks_reviewed: u32,
    /// Notes on files.
    pub notes: u32,
    /// Notes resolved.
    pub resolved: u32,
    /// When it was last written, Unix seconds.
    pub updated_at: i64,
}

/// A repository's reviews, the one written last first.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct Reviews {
    /// The repository's working tree root.
    pub repo: String,
    /// Its reviews.
    pub reviews: Vec<ReviewSummary>,
}

/// A note's resolution.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    /// What the resolver said about it, possibly empty.
    pub reply: String,
    /// When it was resolved, Unix seconds.
    pub resolved_at: i64,
}

/// The note on a file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    /// Its text.
    pub text: String,
    /// When it was written, Unix seconds: resolve_note's `noteUpdatedAt`.
    pub updated_at: i64,
    /// Its resolution, when it was resolved.
    pub resolution: Option<Resolved>,
}

/// What a review holds about one file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileReview {
    /// The file, repository-relative, with forward slashes.
    pub path: String,
    /// The user marked the whole file reviewed (for the content it had then).
    pub reviewed: bool,
    /// How many of its hunks the user marked reviewed.
    pub reviewed_hunks: u32,
    /// The note on it, if any.
    pub note: Option<Note>,
}

/// A review: what the user marked and wrote on a target's files.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    /// The repository's working tree root.
    pub repo: String,
    /// The review's target key.
    pub target: String,
    /// Files the user marked reviewed as a whole.
    pub files_reviewed: u32,
    /// Hunks the user marked reviewed.
    pub hunks_reviewed: u32,
    /// By path: the files with a note, or, when asked, every file with a mark or a note.
    pub files: Vec<FileReview>,
}

/// What a write did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, JsonSchema)]
pub struct Written {
    /// The repository's working tree root.
    pub repo: String,
    /// The review's target key.
    pub target: String,
    /// The file.
    pub path: String,
    /// Whether something changed: for a deletion, whether the note existed; for a reopening,
    /// whether the note was resolved.
    pub changed: bool,
}

/// The two spellings of a repository's root: as `git-core` opens it from the folder given,
/// and as the file system spells it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spellings {
    given: PathBuf,
    spelled: PathBuf,
}

/// Begitra's index, opened on first use and kept.
pub struct Store {
    path: PathBuf,
    index: Option<Index>,
}

impl Store {
    /// A store over the index file at `path`, not opened yet.
    pub fn new(path: PathBuf) -> Self {
        Self { path, index: None }
    }

    /// The index: opened when the file exists, never created nor migrated, and checked to be
    /// of this build's schema at every use, since the app may have been updated meanwhile.
    fn index(&mut self) -> StoreResult<&Index> {
        if let Some(index) = &self.index {
            if let Err(error) = index.check_version() {
                self.index = None;
                return Err(error.into());
            }
        } else {
            if !self.path.is_file() {
                return Err(Failure::new(
                    "index.not_found",
                    format!(
                        "Begitra has no index at {}: open Begitra once, then try again",
                        self.path.display()
                    ),
                ));
            }
            self.index = Some(Index::open_existing(&self.path)?);
        }
        self.index
            .as_ref()
            .ok_or_else(|| Failure::internal("the index did not open"))
    }

    /// The key Begitra stores the repository's reviews under, as the app's `open_path`
    /// chooses its root: the file system's spelling, unless the index holds the root as
    /// given and not that spelling.
    pub fn key_of(&mut self, spellings: &Spellings) -> StoreResult<PathBuf> {
        let index = self.index()?;
        if index.get(&spellings.spelled)?.is_none() && index.get(&spellings.given)?.is_some() {
            Ok(spellings.given.clone())
        } else {
            Ok(spellings.spelled.clone())
        }
    }

    /// The repositories and worktrees of the index, with the projects that hold them.
    pub fn repositories(&mut self) -> StoreResult<Repositories> {
        let index = self.index()?;
        let projects = index.projects()?;
        let mut repositories: Vec<Repository> = index
            .list()?
            .into_iter()
            .map(|entry| Repository {
                projects: projects
                    .iter()
                    .filter(|project| project.members.iter().any(|m| m.path == entry.path))
                    .map(|project| project.name.clone())
                    .collect(),
                path: entry.path.to_string_lossy().into_owned(),
                name: entry.name,
                kind: match entry.kind {
                    RepoKind::Main => "main",
                    RepoKind::Worktree => "worktree",
                }
                .to_owned(),
            })
            .collect();
        repositories.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(Repositories { repositories })
    }

    /// The reviews of the repository keyed `root`, the one written last first.
    pub fn reviews(&mut self, root: &Path) -> StoreResult<Reviews> {
        let reviews = self
            .index()?
            .annotation_targets(root)?
            .into_iter()
            .map(|target| ReviewSummary {
                target: target.target,
                files_reviewed: target.files_reviewed,
                hunks_reviewed: target.hunks_reviewed,
                notes: target.notes,
                resolved: target.resolved,
                updated_at: target.updated_at,
            })
            .collect();
        Ok(Reviews {
            repo: display(root),
            reviews,
        })
    }

    /// The review of `target` in the repository keyed `root`, or its review written last:
    /// the files with a note, or with `all_files` every file with a mark or a note (a review
    /// of thousands of files would otherwise not reach an agent whole).
    pub fn review(
        &mut self,
        root: &Path,
        target: Option<&str>,
        all_files: bool,
    ) -> StoreResult<Review> {
        let index = self.index()?;
        let target = match target {
            Some(target) => checked_target(target)?.to_owned(),
            None => index
                .annotation_targets(root)?
                .into_iter()
                .next()
                .map(|target| target.target)
                .ok_or_else(|| {
                    Failure::new(
                        "review.not_found",
                        format!("no review of {} holds marks or notes", root.display()),
                    )
                })?,
        };
        let listed = index.list_annotations(root, &target)?;
        if listed.is_empty() {
            return Err(Failure::new(
                "review.not_found",
                format!("the review {target} of {} holds nothing", root.display()),
            ));
        }
        // The rows come by path, then hunk, then kind: a file's note before its resolution.
        let mut review = Review {
            repo: display(root),
            target,
            files_reviewed: 0,
            hunks_reviewed: 0,
            files: Vec::new(),
        };
        let mut file: Option<FileReview> = None;
        for annotation in listed {
            if file
                .as_ref()
                .is_some_and(|file| file.path != annotation.path)
            {
                push_file(&mut review.files, file.take(), all_files);
            }
            let current = file.get_or_insert_with(|| FileReview {
                path: annotation.path.clone(),
                reviewed: false,
                reviewed_hunks: 0,
                note: None,
            });
            match (annotation.kind, annotation.hunk.is_empty()) {
                (AnnotationKind::Reviewed, true) => {
                    current.reviewed = true;
                    review.files_reviewed += 1;
                }
                (AnnotationKind::Reviewed, false) => {
                    current.reviewed_hunks += 1;
                    review.hunks_reviewed += 1;
                }
                (AnnotationKind::Note, true) => {
                    current.note = Some(Note {
                        text: annotation.value,
                        updated_at: annotation.updated_at,
                        resolution: None,
                    });
                }
                (AnnotationKind::Resolved, true) => {
                    if let Some(note) = current.note.as_mut() {
                        note.resolution = Some(Resolved {
                            reply: annotation.value,
                            resolved_at: annotation.updated_at,
                        });
                    }
                }
                // Notes and resolutions on hunks are written by nothing.
                (AnnotationKind::Note | AnnotationKind::Resolved, false) => {}
            }
        }
        push_file(&mut review.files, file, all_files);
        Ok(review)
    }

    /// Writes or replaces the note on `path`; a new text loses the old one's resolution. The
    /// target must be one the app shows: a review that holds something, the working tree,
    /// the index, or a commit named by its full hash.
    pub fn set_note(
        &mut self,
        root: &Path,
        target: &str,
        path: &str,
        text: &str,
        now: i64,
    ) -> StoreResult<Written> {
        let target = checked_target(target)?;
        let path = checked_path(path)?;
        let text = text.trim();
        if text.is_empty() {
            return Err(Failure::invalid(
                "a note needs text; delete_note deletes one",
            ));
        }
        checked_length(text, "text")?;
        let index = self.index()?;
        let known = matches!(target, "worktree" | "index")
            || is_full_hash(target)
            || index
                .annotation_targets(root)?
                .iter()
                .any(|known| known.target == target);
        if !known {
            return Err(Failure::new(
                "review.not_found",
                format!(
                    "{target} is no review of {}: use worktree, index, a commit's full hash or \
                     a review list_reviews names",
                    root.display()
                ),
            ));
        }
        index.set_annotation(&note_key(root, target, &path), text, now)?;
        Ok(written(root, target, path, true))
    }

    /// Deletes the note on `path` with its resolution.
    pub fn delete_note(&mut self, root: &Path, target: &str, path: &str) -> StoreResult<Written> {
        let target = checked_target(target)?;
        let path = checked_path(path)?;
        let index = self.index()?;
        let existed = index.delete_annotation(&note_key(root, target, &path))?;
        Ok(written(root, target, path, existed))
    }

    /// Resolves the note on `path` with `reply`; with `note_updated_at`, only the note written
    /// then (`note.changed` otherwise).
    pub fn resolve_note(
        &mut self,
        root: &Path,
        target: &str,
        path: &str,
        reply: &str,
        note_updated_at: Option<i64>,
        now: i64,
    ) -> StoreResult<Written> {
        let target = checked_target(target)?;
        let path = checked_path(path)?;
        let reply = reply.trim();
        checked_length(reply, "reply")?;
        let index = self.index()?;
        match index.resolve_note(&note_key(root, target, &path), reply, now, note_updated_at)? {
            Resolution::Resolved => Ok(written(root, target, path, true)),
            Resolution::NoNote => Err(no_note(target, &path)),
            Resolution::Changed => Err(Failure::new(
                "note.changed",
                format!(
                    "the user rewrote the note on {path} since it was read: read the review \
                     again"
                ),
            )),
        }
    }

    /// Removes the resolution of the note on `path`.
    pub fn reopen_note(&mut self, root: &Path, target: &str, path: &str) -> StoreResult<Written> {
        let target = checked_target(target)?;
        let path = checked_path(path)?;
        let index = self.index()?;
        match index.reopen_note(&note_key(root, target, &path))? {
            Some(removed) => Ok(written(root, target, path, removed)),
            None => Err(no_note(target, &path)),
        }
    }
}

/// The spellings of the repository at or above `folder`. Reads the disk (`git-core` opens the
/// repository, the file system resolves the root): run it before the store's lock.
pub fn spellings(folder: &Path) -> StoreResult<Spellings> {
    if is_remote_or_device(folder) {
        return Err(Failure::invalid(
            "repo must be a local folder, not a network share or a device path",
        ));
    }
    let root = repository_root(folder)?;
    Ok(Spellings {
        given: normalise(&root),
        spelled: canonical(&root),
    })
}

/// The working tree root of the repository at or above `folder`, as `git-core` opens it.
pub fn repository_root(folder: &Path) -> StoreResult<PathBuf> {
    match Git2Engine::open(folder) {
        Ok(engine) => Ok(engine.repo().root.clone()),
        Err(GitError::NotFound(_)) => Err(Failure::new(
            "repo.not_found",
            format!("no Git repository at or above {}", folder.display()),
        )),
        Err(error) => Err(Failure::new("repo.unreadable", error.to_string())),
    }
}

/// A UNC share (`\\host\share`, `//host/share`) or a device path (`\\?\`, `\\.\`): Windows
/// would authenticate to the host, or reach past the file system, to read it.
fn is_remote_or_device(folder: &Path) -> bool {
    let text = folder.to_string_lossy();
    text.starts_with(r"\\") || text.starts_with("//")
}

/// Adds `file` to the review's list: always with a note, otherwise when asked for every file.
fn push_file(files: &mut Vec<FileReview>, file: Option<FileReview>, all_files: bool) {
    if let Some(file) = file {
        if all_files || file.note.is_some() {
            files.push(file);
        }
    }
}

fn note_key<'a>(root: &'a Path, target: &'a str, path: &'a str) -> AnnotationKey<'a> {
    AnnotationKey {
        repo: root,
        target,
        path,
        hunk: "",
        kind: AnnotationKind::Note,
    }
}

fn written(root: &Path, target: &str, path: String, changed: bool) -> Written {
    Written {
        repo: display(root),
        target: target.to_owned(),
        path,
        changed,
    }
}

fn no_note(target: &str, path: &str) -> Failure {
    Failure::new(
        "note.not_found",
        format!("{path} has no note in the review {target}"),
    )
}

fn display(root: &Path) -> String {
    root.to_string_lossy().into_owned()
}

/// A commit's full hash: 40 or 64 hexadecimal digits.
fn is_full_hash(target: &str) -> bool {
    matches!(target.len(), 40 | 64) && target.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn checked_target(target: &str) -> StoreResult<&str> {
    let target = target.trim();
    if target.is_empty() || target.len() > MAX_KEY_BYTES {
        return Err(Failure::invalid(format!(
            "target must be a review's key of 1 to {MAX_KEY_BYTES} bytes"
        )));
    }
    Ok(target)
}

/// A file's path as the app stores it: repository-relative with forward slashes, without a
/// leading `./`, each segment a name (no empty, `.` or `..` segment, no drive).
fn checked_path(path: &str) -> StoreResult<String> {
    let path = path.trim().replace('\\', "/");
    let path = path.trim_start_matches("./");
    let refused = || {
        Failure::invalid(format!(
            "path must be a repository-relative file path of 1 to {MAX_PATH_BYTES} bytes, \
             with forward slashes and no `.` or `..` segment"
        ))
    };
    if path.is_empty() || path.len() > MAX_PATH_BYTES {
        return Err(refused());
    }
    let mut segments = path.split('/');
    if segments.next().is_some_and(|first| {
        first.contains(':') || first.is_empty() || first == "." || first == ".."
    }) {
        return Err(refused());
    }
    if segments.any(|segment| segment.is_empty() || segment == "." || segment == "..") {
        return Err(refused());
    }
    Ok(path.to_owned())
}

fn checked_length(text: &str, field: &str) -> StoreResult<()> {
    if text.chars().count() > MAX_NOTE_CHARS {
        return Err(Failure::invalid(format!(
            "{field} is longer than {MAX_NOTE_CHARS} characters"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A repository with a subfolder, and an index the app wrote, in a temporary folder.
    struct Fixture {
        _dir: tempfile::TempDir,
        repo: PathBuf,
        index: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().expect("temporary folder");
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join("src")).expect("folders");
        let mut git = std::process::Command::new("git");
        git.args(["init", "-q"]).current_dir(&repo);
        // A hook of a linked worktree exports these, which would aim the command elsewhere.
        for var in git_core::cli::REDIRECTING_VARS {
            git.env_remove(var);
        }
        let status = git.status().expect("git");
        assert!(status.success());
        let index = dir.path().join("index.sqlite");
        drop(Index::open(&index).expect("the app's index"));
        Fixture {
            _dir: dir,
            repo,
            index,
        }
    }

    /// The key the app stores the fixture's repository under: its canonical root.
    fn app_key(f: &Fixture) -> PathBuf {
        canonical(&repository_root(&f.repo).expect("root"))
    }

    /// Writes as the app does, under the app's key.
    fn app_writes(
        f: &Fixture,
        target: &str,
        path: &str,
        hunk: &str,
        kind: AnnotationKind,
        value: &str,
    ) {
        let root = app_key(f);
        let index = Index::open(&f.index).expect("index");
        index
            .set_annotation(
                &AnnotationKey {
                    repo: &root,
                    target,
                    path,
                    hunk,
                    kind,
                },
                value,
                100,
            )
            .expect("write");
    }

    fn key(store: &mut Store, folder: &Path) -> PathBuf {
        store
            .key_of(&spellings(folder).expect("spellings"))
            .expect("key")
    }

    #[test]
    fn an_index_the_app_never_wrote_is_not_created() {
        let dir = tempfile::tempdir().expect("temporary folder");
        let missing = dir.path().join("index.sqlite");
        let mut store = Store::new(missing.clone());
        let failure = store.repositories().expect_err("no index");
        assert_eq!(failure.code, "index.not_found");
        assert!(!missing.exists());
    }

    #[test]
    fn an_index_of_another_version_is_neither_read_nor_migrated() {
        let f = fixture();
        let mut store = Store::new(f.index.clone());
        store.repositories().expect("this build's index");
        let other = rusqlite::Connection::open(&f.index).expect("connection");
        let version: u32 = other
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("version");
        other
            .pragma_update(None, "user_version", version + 1)
            .expect("an app of another version");
        assert_eq!(
            store.repositories().expect_err("another schema").code,
            "index.version"
        );
        let after: u32 = other
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("version");
        assert_eq!(after, version + 1, "the server migrated the file");
    }

    #[test]
    fn a_folder_names_its_repository_as_the_app_stores_it() {
        let f = fixture();
        let mut store = Store::new(f.index.clone());
        let expected = app_key(&f);
        assert_eq!(key(&mut store, &f.repo), expected);
        assert_eq!(key(&mut store, &f.repo.join("src")), expected);
        let outside = tempfile::tempdir().expect("temporary folder");
        let failure = spellings(outside.path()).expect_err("not a repository");
        assert_eq!(failure.code, "repo.not_found");
        assert_eq!(
            spellings(Path::new(r"\\nas\share\code"))
                .expect_err("a share")
                .code,
            "invalid_argument"
        );
    }

    /// A drive letter in lower case (as VS Code's terminals give it) names the repository the
    /// app stored with the file system's spelling.
    #[cfg(windows)]
    #[test]
    fn a_folder_spelled_another_way_names_the_same_repository() {
        let f = fixture();
        let mut store = Store::new(f.index.clone());
        let spelled = f.repo.to_string_lossy().into_owned();
        let mut lower = spelled.clone();
        lower.replace_range(..1, &spelled[..1].to_lowercase());
        assert_ne!(lower, spelled);
        assert_eq!(key(&mut store, Path::new(&lower)), app_key(&f));
    }

    #[test]
    fn reads_what_the_app_wrote_and_writes_what_it_reads() {
        let f = fixture();
        app_writes(
            &f,
            "worktree",
            "src/a.ts",
            "",
            AnnotationKind::Reviewed,
            "1",
        );
        app_writes(
            &f,
            "worktree",
            "src/a.ts",
            "@@ -1 +1 @@",
            AnnotationKind::Reviewed,
            "1",
        );
        app_writes(
            &f,
            "worktree",
            "src/b.ts",
            "",
            AnnotationKind::Note,
            "Handle []",
        );
        let mut store = Store::new(f.index.clone());
        let root = key(&mut store, &f.repo.join("src"));

        let reviews = store.reviews(&root).expect("reviews");
        assert_eq!(reviews.reviews.len(), 1);
        assert_eq!(reviews.reviews[0].target, "worktree");

        // By default the files with a note, and the counts of the rest.
        let review = store
            .review(&root, None, false)
            .expect("the review written last");
        assert_eq!(review.target, "worktree");
        assert_eq!((review.files_reviewed, review.hunks_reviewed), (1, 1));
        let paths: Vec<&str> = review.files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, ["src/b.ts"]);
        let all = store.review(&root, None, true).expect("every file");
        let paths: Vec<&str> = all.files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, ["src/a.ts", "src/b.ts"]);
        assert!(all.files[0].reviewed);
        assert_eq!(all.files[0].reviewed_hunks, 1);

        let note = review.files[0].note.as_ref().expect("the note");
        // A path as an agent on Windows may write it is the app's.
        let written = store
            .resolve_note(
                &root,
                "worktree",
                r".\src\b.ts",
                " Returns early ",
                Some(note.updated_at),
                200,
            )
            .expect("resolve");
        assert_eq!(written.path, "src/b.ts");
        let review = store
            .review(&root, Some("worktree"), false)
            .expect("review");
        assert_eq!(
            review.files[0]
                .note
                .as_ref()
                .and_then(|note| note.resolution.as_ref())
                .map(|resolution| (resolution.reply.as_str(), resolution.resolved_at)),
            Some(("Returns early", 200))
        );

        assert!(
            store
                .reopen_note(&root, "worktree", "src/b.ts")
                .expect("reopen")
                .changed
        );
        assert!(
            !store
                .reopen_note(&root, "worktree", "src/b.ts")
                .expect("open")
                .changed
        );

        store
            .set_note(&root, "worktree", "src/c.ts", "Split this function", 300)
            .expect("an agent's note");
        assert!(
            store
                .delete_note(&root, "worktree", "src/c.ts")
                .expect("delete")
                .changed
        );
        assert!(
            !store
                .delete_note(&root, "worktree", "src/c.ts")
                .expect("again")
                .changed
        );
    }

    #[test]
    fn failures_carry_their_codes() {
        let f = fixture();
        app_writes(
            &f,
            "worktree",
            "src/b.ts",
            "",
            AnnotationKind::Note,
            "Check this",
        );
        let mut store = Store::new(f.index.clone());
        let root = key(&mut store, &f.repo);
        let code = |result: StoreResult<Written>| result.expect_err("a failure").code;
        assert_eq!(
            store
                .review(&root, Some("0123abcd"), false)
                .expect_err("nothing stored")
                .code,
            "review.not_found"
        );
        assert_eq!(
            code(store.resolve_note(&root, "worktree", "src/a.ts", "", None, 1)),
            "note.not_found"
        );
        // The user rewrote the note since the agent read it.
        assert_eq!(
            code(store.resolve_note(&root, "worktree", "src/b.ts", "", Some(1), 2)),
            "note.changed"
        );
        assert_eq!(
            code(store.reopen_note(&root, "worktree", "src/a.ts")),
            "note.not_found"
        );
        assert_eq!(
            code(store.set_note(&root, "worktree", "src/a.ts", "   ", 1)),
            "invalid_argument"
        );
        for path in [
            "/etc/passwd",
            "../outside.ts",
            "src/../../etc/passwd",
            "src/./a.ts",
            "src//a.ts",
            "src/a.ts/",
            ".",
            "C:src/a.ts",
        ] {
            assert_eq!(
                code(store.set_note(&root, "worktree", path, "x", 1)),
                "invalid_argument",
                "{path}"
            );
        }
        assert_eq!(
            code(store.set_note(&root, "", "src/a.ts", "x", 1)),
            "invalid_argument"
        );
        // A target the app never shows.
        assert_eq!(
            code(store.set_note(&root, "HEAD~3", "src/a.ts", "x", 1)),
            "review.not_found"
        );
        let hash = "0".repeat(40);
        store
            .set_note(&root, &hash, "src/a.ts", "On this commit", 1)
            .expect("a commit by its full hash");
        let long = "x".repeat(MAX_NOTE_CHARS + 1);
        assert_eq!(
            code(store.set_note(&root, "worktree", "src/a.ts", &long, 1)),
            "invalid_argument"
        );
    }
}
