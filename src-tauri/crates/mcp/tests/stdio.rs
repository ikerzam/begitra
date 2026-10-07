//! The server as an MCP client meets it: the binary over stdio, a session from `initialize` to
//! closing its input, reading what the app wrote and writing what the app reads.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

use git_core::spelling::canonical;
use repo_index::{AnnotationKey, AnnotationKind, Index};
use serde_json::{json, Value};

/// The longest a test waits for a message: a hung server fails the test, not the suite.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

struct Session {
    child: Child,
    input: ChildStdin,
    lines: Receiver<String>,
    next_id: u64,
}

impl Session {
    fn start(folder: &Path, index: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_begitra-mcp"))
            .current_dir(folder)
            .env("BEGITRA_INDEX", index)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("start the server");
        let input = child.stdin.take().expect("stdin");
        let output = BufReader::new(child.stdout.take().expect("stdout"));
        // Lines arrive on a thread, so a read can give up.
        let (sender, lines) = mpsc::channel();
        std::thread::spawn(move || {
            for line in output.lines().map_while(Result::ok) {
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        let mut session = Self {
            child,
            input,
            lines,
            next_id: 0,
        };
        let init = session.request(
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "test", "version": "0" }
            }),
        );
        assert_eq!(init["serverInfo"]["name"], "begitra");
        assert_eq!(init["serverInfo"]["version"], env!("CARGO_PKG_VERSION"));
        session.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
        session
    }

    fn send(&mut self, message: &Value) {
        writeln!(self.input, "{message}").expect("write");
        self.input.flush().expect("flush");
    }

    /// Sends a request and answers its result, skipping the notifications before it.
    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        loop {
            let line = self
                .lines
                .recv_timeout(READ_TIMEOUT)
                .expect("an answer before the timeout");
            let message: Value = serde_json::from_str(&line).expect("a JSON-RPC message");
            if message["id"] == json!(id) {
                assert!(message.get("error").is_none(), "{message}");
                return message["result"].clone();
            }
        }
    }

    fn call(&mut self, tool: &str, arguments: Value) -> Value {
        self.request(
            "tools/call",
            json!({ "name": tool, "arguments": arguments }),
        )
    }

    fn finish(mut self) {
        drop(self.input);
        let status = self.child.wait().expect("wait");
        assert!(status.success(), "{status}");
    }
}

/// A repository with a subfolder and the app's index, in a temporary folder.
fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().expect("temporary folder");
    let repo = dir.path().join("repo");
    std::fs::create_dir_all(repo.join("src")).expect("folders");
    let mut git = Command::new("git");
    git.args(["init", "-q"]).current_dir(&repo);
    for var in git_core::cli::REDIRECTING_VARS {
        git.env_remove(var);
    }
    assert!(git.status().expect("git").success());
    let index = dir.path().join("index.sqlite");
    drop(Index::open(&index).expect("the app's index"));
    (dir, repo, index)
}

#[test]
fn an_agent_reads_the_notes_and_resolves_one_that_the_app_then_reads() {
    let (_dir, repo, index_path) = fixture();
    // The app keys a repository by the file system's spelling of its root.
    let root = canonical(&begitra_mcp::store::repository_root(&repo).expect("root"));
    let index = Index::open(&index_path).expect("index");
    let note = AnnotationKey {
        repo: &root,
        target: "worktree",
        path: "src/auth.ts",
        hunk: "",
        kind: AnnotationKind::Note,
    };
    index
        .set_annotation(&note, "Refresh the token before it expires", 10)
        .expect("the user's note");

    // Started in a subfolder, as an agent in the project would be.
    let mut session = Session::start(&repo.join("src"), &index_path);
    let listed = session.request("tools/list", json!({}));
    let tools = listed["tools"].as_array().expect("tools");
    let mut names: Vec<&str> = tools
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    names.sort_unstable();
    assert_eq!(
        names,
        [
            "delete_note",
            "get_review",
            "list_repositories",
            "list_reviews",
            "reopen_note",
            "resolve_note",
            "set_note"
        ]
    );
    let tool = |name: &str| {
        tools
            .iter()
            .find(|tool| tool["name"] == name)
            .cloned()
            .unwrap_or(Value::Null)
    };
    // Each tool says what it answers, and which only read or replace the user's notes.
    assert!(tool("get_review")["outputSchema"].is_object());
    assert_eq!(
        tool("get_review")["annotations"]["readOnlyHint"],
        json!(true)
    );
    assert_eq!(
        tool("delete_note")["annotations"]["destructiveHint"],
        json!(true)
    );

    let review = session.call("get_review", json!({}));
    assert_eq!(review["isError"], json!(false), "{review}");
    let content = &review["structuredContent"];
    assert_eq!(content["target"], "worktree");
    assert_eq!(content["files"][0]["path"], "src/auth.ts");
    let read = &content["files"][0]["note"];
    assert_eq!(read["text"], "Refresh the token before it expires");

    let resolved = session.call(
        "resolve_note",
        json!({
            "target": "worktree",
            "path": "src/auth.ts",
            "reply": "Refreshes 60 s early",
            "noteUpdatedAt": read["updatedAt"]
        }),
    );
    assert_eq!(resolved["isError"], json!(false), "{resolved}");

    let failed = session.call(
        "resolve_note",
        json!({ "target": "worktree", "path": "src/none.ts" }),
    );
    assert_eq!(failed["isError"], json!(true));
    assert_eq!(failed["structuredContent"]["code"], "note.not_found");

    let outside = tempfile::tempdir().expect("temporary folder");
    let failed = session.call(
        "list_reviews",
        json!({ "repo": outside.path().to_string_lossy() }),
    );
    assert_eq!(failed["structuredContent"]["code"], "repo.not_found");
    session.finish();

    // What the app's commands read: the note with its resolution.
    let listed = index.list_annotations(&root, "worktree").expect("list");
    let resolution = listed
        .iter()
        .find(|annotation| annotation.kind == AnnotationKind::Resolved)
        .expect("the resolution");
    assert_eq!(resolution.path, "src/auth.ts");
    assert_eq!(resolution.value, "Refreshes 60 s early");
}
