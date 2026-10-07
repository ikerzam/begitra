//! The MCP server: one tool per store operation. Each runs on the blocking pool (SQLite and
//! libgit2 block) within [`CALL_TIMEOUT`], resolving the folder it names before it takes the
//! store's lock, and a failure answers as a tool error whose content is `{ code, message }`,
//! which an agent reads as it reads a result, rather than as a protocol error it would only
//! see as "internal error".

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rmcp::handler::server::wrapper::{Json, Parameters};
use rmcp::model::CallToolResult;
use rmcp::{tool, tool_handler, tool_router, ServerHandler};
use schemars::JsonSchema;
use serde::Deserialize;

use crate::store::{self, Failure, Repositories, Review, Reviews, Store, StoreResult, Written};

/// The longest a call may take: a folder on a share that does not answer, or an index locked
/// past its busy timeout over and over, answers `op.timeout` rather than hang the agent.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Names a repository.
#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RepoArgs {
    /// The repository: its folder, or any folder inside it. Defaults to the folder the
    /// server runs in, the agent's project.
    #[serde(default)]
    pub repo: Option<String>,
}

/// Names a review.
#[derive(Debug, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReviewArgs {
    /// The repository: its folder, or any folder inside it. Defaults to the folder the
    /// server runs in, the agent's project.
    #[serde(default)]
    pub repo: Option<String>,
    /// The review's target key, as list_reviews names it: `worktree` (the working tree's
    /// changes), `index` (the staged ones), a commit's full hash, a range `a..b` or `a...b`,
    /// or `rev..worktree`. Defaults to the review written last.
    #[serde(default)]
    pub target: Option<String>,
    /// List every file the user marked, not only the files with a note (whose counts come
    /// anyway). A review of thousands of files is long.
    #[serde(default)]
    pub include_reviewed: Option<bool>,
}

/// Names a file of a review.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileArgs {
    /// The repository: its folder, or any folder inside it. Defaults to the folder the
    /// server runs in, the agent's project.
    #[serde(default)]
    pub repo: Option<String>,
    /// The review's target key, as get_review or list_reviews names it.
    pub target: String,
    /// The file, repository-relative with forward slashes, as get_review names it.
    pub path: String,
}

/// A note to write.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetNoteArgs {
    /// The repository: its folder, or any folder inside it. Defaults to the folder the
    /// server runs in, the agent's project.
    #[serde(default)]
    pub repo: Option<String>,
    /// The review's target key: `worktree`, `index`, a commit's full hash, or a review
    /// list_reviews names.
    pub target: String,
    /// The file, repository-relative with forward slashes.
    pub path: String,
    /// The note's text (Markdown), at most 10,000 characters.
    pub text: String,
}

/// A note to resolve.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResolveArgs {
    /// The repository: its folder, or any folder inside it. Defaults to the folder the
    /// server runs in, the agent's project.
    #[serde(default)]
    pub repo: Option<String>,
    /// The review's target key, as get_review names it.
    pub target: String,
    /// The file whose note is resolved, as get_review names it.
    pub path: String,
    /// A short reply saying what was changed, which the user reads under the note.
    #[serde(default)]
    pub reply: Option<String>,
    /// The note's updatedAt as get_review gave it: when the user rewrote the note since, the
    /// resolution is refused (`note.changed`) rather than answer a text it did not read.
    #[serde(default)]
    pub note_updated_at: Option<i64>,
}

/// The agent server over one index.
#[derive(Clone)]
pub struct Server {
    store: Arc<Mutex<Store>>,
    folder: PathBuf,
}

impl Server {
    /// A server over `store`, whose default repository is the one at or above `folder`.
    pub fn new(store: Store, folder: PathBuf) -> Self {
        Self {
            store: Arc::new(Mutex::new(store)),
            folder,
        }
    }

    /// The folder a tool names, or the server's own.
    fn folder_of(&self, repo: Option<String>) -> PathBuf {
        repo.filter(|repo| !repo.trim().is_empty())
            .map_or_else(|| self.folder.clone(), PathBuf::from)
    }

    /// Runs `work` on the blocking pool within [`CALL_TIMEOUT`], in a span named for `tool`.
    /// `work` takes the store's lock itself, after the work that reads the disk.
    async fn run<T, F>(&self, tool: &'static str, work: F) -> Result<Json<T>, CallToolResult>
    where
        T: Send + 'static,
        F: FnOnce(&Mutex<Store>) -> StoreResult<T> + Send + 'static,
    {
        let store = Arc::clone(&self.store);
        let span = tracing::info_span!("tool", name = tool);
        let task = tokio::task::spawn_blocking(move || {
            let _entered = span.enter();
            let result = work(&store);
            if let Err(failure) = &result {
                tracing::debug!(code = failure.code, message = %failure.message, "failed");
            }
            result
        });
        match tokio::time::timeout(CALL_TIMEOUT, task).await {
            Ok(Ok(Ok(value))) => Ok(Json(value)),
            Ok(Ok(Err(failure))) => Err(tool_error(&failure)),
            Ok(Err(join)) => Err(tool_error(&Failure::internal(join.to_string()))),
            Err(_) => Err(tool_error(&Failure::timeout(format!(
                "{tool} took longer than {} s",
                CALL_TIMEOUT.as_secs()
            )))),
        }
    }
}

/// The store, its lock taken (a panic in another call does not keep it).
fn locked(store: &Mutex<Store>) -> MutexGuard<'_, Store> {
    store.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The key of the repository at or above `folder`: its spellings read from the disk first,
/// then the lock taken to ask the index which one the app stored.
fn keyed<'a>(
    store: &'a Mutex<Store>,
    folder: &Path,
) -> StoreResult<(MutexGuard<'a, Store>, PathBuf)> {
    let spellings = store::spellings(folder)?;
    let mut guard = locked(store);
    let key = guard.key_of(&spellings)?;
    Ok((guard, key))
}

/// A tool error whose content is `{ code, message }`.
fn tool_error(failure: &Failure) -> CallToolResult {
    CallToolResult::structured_error(serde_json::json!({
        "code": failure.code,
        "message": failure.message,
    }))
}

/// Now, in Unix seconds.
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX)
        })
}

#[tool_router]
impl Server {
    #[tool(
        description = "List the Git repositories and worktrees Begitra knows, with the projects that hold them. Use it to find a repository's path when your working folder is not inside it.",
        annotations(read_only_hint = true)
    )]
    async fn list_repositories(&self) -> Result<Json<Repositories>, CallToolResult> {
        self.run("list_repositories", |store| locked(store).repositories())
            .await
    }

    #[tool(
        description = "List the reviews of a repository that hold marks or notes, the one written last first: each review's target key (worktree, index, a commit hash, a range such as main..feature) with how many files and hunks the user marked reviewed and how many notes there are and are resolved.",
        annotations(read_only_hint = true)
    )]
    async fn list_reviews(
        &self,
        Parameters(args): Parameters<RepoArgs>,
    ) -> Result<Json<Reviews>, CallToolResult> {
        let folder = self.folder_of(args.repo);
        self.run("list_reviews", move |store| {
            let (mut store, root) = keyed(store, &folder)?;
            store.reviews(&root)
        })
        .await
    }

    #[tool(
        description = "Read the user's review of a repository in Begitra: the files with the user's notes (each note's text, when it was written and its resolution), and how many files and hunks the user marked reviewed; includeReviewed lists the marked files too. Call it to find what the user asked you to change. Without target, the review written last is read.",
        annotations(read_only_hint = true)
    )]
    async fn get_review(
        &self,
        Parameters(args): Parameters<ReviewArgs>,
    ) -> Result<Json<Review>, CallToolResult> {
        let folder = self.folder_of(args.repo);
        self.run("get_review", move |store| {
            let (mut store, root) = keyed(store, &folder)?;
            store.review(
                &root,
                args.target.as_deref(),
                args.include_reviewed.unwrap_or(false),
            )
        })
        .await
    }

    #[tool(
        description = "Write the note on a file of a review, replacing the note it had, the user's included: read the review with get_review first. Use it to leave the user a note; to answer the user's note, resolve it with resolve_note instead.",
        annotations(destructive_hint = true)
    )]
    async fn set_note(
        &self,
        Parameters(args): Parameters<SetNoteArgs>,
    ) -> Result<Json<Written>, CallToolResult> {
        let folder = self.folder_of(args.repo);
        self.run("set_note", move |store| {
            let (mut store, root) = keyed(store, &folder)?;
            store.set_note(&root, &args.target, &args.path, &args.text, now())
        })
        .await
    }

    #[tool(
        description = "Delete the note on a file of a review, with its resolution.",
        annotations(destructive_hint = true)
    )]
    async fn delete_note(
        &self,
        Parameters(args): Parameters<FileArgs>,
    ) -> Result<Json<Written>, CallToolResult> {
        let folder = self.folder_of(args.repo);
        self.run("delete_note", move |store| {
            let (mut store, root) = keyed(store, &folder)?;
            store.delete_note(&root, &args.target, &args.path)
        })
        .await
    }

    #[tool(
        description = "Mark the user's note on a file resolved, with a short reply saying what you changed. Call it once you addressed the note, passing the note's updatedAt from get_review; Begitra shows it resolved, with your reply, and the user can reopen it."
    )]
    async fn resolve_note(
        &self,
        Parameters(args): Parameters<ResolveArgs>,
    ) -> Result<Json<Written>, CallToolResult> {
        let folder = self.folder_of(args.repo);
        self.run("resolve_note", move |store| {
            let (mut store, root) = keyed(store, &folder)?;
            let reply = args.reply.unwrap_or_default();
            store.resolve_note(
                &root,
                &args.target,
                &args.path,
                &reply,
                args.note_updated_at,
                now(),
            )
        })
        .await
    }

    #[tool(description = "Remove the resolution of a note, so it shows as open again.")]
    async fn reopen_note(
        &self,
        Parameters(args): Parameters<FileArgs>,
    ) -> Result<Json<Written>, CallToolResult> {
        let folder = self.folder_of(args.repo);
        self.run("reopen_note", move |store| {
            let (mut store, root) = keyed(store, &folder)?;
            store.reopen_note(&root, &args.target, &args.path)
        })
        .await
    }
}

#[tool_handler(
    name = "begitra",
    instructions = "Begitra is the Git client where the user reviews code. Read the user's review of a repository with get_review and act on its notes; once you addressed a note, resolve it with resolve_note, its updatedAt and a short reply. Leave the user notes of your own with set_note. Which files are marked reviewed is the user's verdict, which you can read and not change."
)]
impl ServerHandler for Server {}
