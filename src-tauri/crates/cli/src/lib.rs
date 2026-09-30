//! Headless CLI over `git-core`: the engine's read operations with JSON
//! output, for scripts and agents that want what the app shows without the window. Every
//! result is the serde shape the IPC bridge returns for the same operation (the fixtures
//! under `src/ipc/fixtures` are their samples): one document on stdout, or, for `log` and
//! `diff`, NDJSON pages followed by `{"kind":"done"}`. A failure is one
//! `{ code, message, detail? }` document on stderr with exit status 1; a usage error is the
//! usage on stderr with exit status 2. Nothing here writes to a repository.
//!
//! Arguments are parsed by hand: a subcommand, a path, a few flags. Ten commands do not
//! justify an argument-parsing dependency. A stream that fails half way ends without the done
//! line: the failure document on stderr is the signal.

use std::io::Write;
use std::path::{Path, PathBuf};

use git_core::engine::{Cancel, GitEngine};
use git_core::error::GitError;
use git_core::git2_engine::Git2Engine;
use git_core::types::{
    BlobAt, DiffOptions, DiffTarget, StatusOptions, WalkOptions, WalkOrder, WalkScope,
    WorkingTreeBase,
};
use serde::Serialize;

/// The usage, printed by `--help` (stdout, status 0) and on a usage error (stderr, status 2).
pub const USAGE: &str = "\
begitra-cli: Begitra's git engine as JSON, for scripts and agents. Read-only.

Usage: begitra-cli <command> <repo> [options]

Commands:
  open <repo>                          the repository as the app opens it
  refs <repo>                          branches, remotes, tags, stashes and HEAD
  log <repo> [--branch <name>] [--limit <n>] [--order lazy|date-topo]
                                       the history (the app's lazy order by default), as NDJSON
                                       pages then {\"kind\":\"done\"}
  status <repo>                        the working tree's changed, untracked and renamed paths
  diff <repo> (--commit <rev> | --range <a>..<b> | --range <a>...<b> | --working-tree [--base head|index])
                                       the change set, as NDJSON pages then {\"kind\":\"done\"}
  compare <repo> <a> <b>               the merge base and what each side has that the other lacks
  worktrees <repo>                     the worktrees with their state
  blob <repo> <file> [--rev <rev>]     one file whole, from the working tree or a revision

Options:
  --pretty        indent single documents (pages stay one per line)
  --json          accepted; every output is JSON
  --              the rest are positionals, even when they start with --
  --help, -h      this text
  --version, -V   the version

Environment:
  BEGITRA_GIT      the git executable to run instead of the one on PATH
";

/// Commits per `log` page, and files per `diff` page.
const LOG_PAGE: u32 = 500;
const DIFF_PAGE: usize = 50;

/// What the arguments asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Open,
    Refs,
    Log {
        scope: WalkScope,
        limit: Option<u32>,
        order: WalkOrder,
    },
    Status,
    Diff {
        target: DiffTarget,
    },
    Compare {
        a: String,
        b: String,
    },
    Worktrees,
    Blob {
        at: BlobAt,
        path: String,
    },
}

/// A parsed command line.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invocation {
    pub command: Command,
    pub repo: PathBuf,
    pub pretty: bool,
}

/// The outcome of parsing: something to run, or one of the two answers that need no repo.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Parsed {
    Run(Invocation),
    Help,
    Version,
}

/// A failure as the IPC bridge shapes it, mapped again here because the bridge lives in the
/// Tauri crate, which this one does not depend on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Failure {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl From<GitError> for Failure {
    fn from(error: GitError) -> Self {
        Self {
            code: error.code().to_owned(),
            message: error.to_string(),
            detail: error.detail().map(str::to_owned),
        }
    }
}

impl From<std::io::Error> for Failure {
    fn from(error: std::io::Error) -> Self {
        Self {
            code: "internal".to_owned(),
            message: format!("could not write the output: {error}"),
            detail: None,
        }
    }
}

impl From<serde_json::Error> for Failure {
    fn from(error: serde_json::Error) -> Self {
        // A write that failed inside serde is an output error (`head` closed the pipe).
        if error.io_error_kind().is_some() {
            return Self::from(std::io::Error::from(error));
        }
        Self {
            code: "internal".to_owned(),
            message: format!("could not serialise the result: {error}"),
            detail: None,
        }
    }
}

impl Failure {
    /// Whether the consumer went away (`begitra-cli log repo | head`): nothing to report.
    fn is_broken_pipe(&self) -> bool {
        self.code == "internal"
            && self.message.contains("could not write the output")
            && (self.message.contains("Broken pipe")
                || self.message.contains("pipe is being closed"))
    }
}

/// A usage error: what was wrong, printed before the usage.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageError(pub String);

/// Reads the flags and positionals of `args` after the command name.
struct Args<'a> {
    positionals: Vec<&'a str>,
    flags: Vec<(&'a str, Option<&'a str>)>,
}

/// Flags that take a value.
const VALUED: [&str; 7] = [
    "--branch", "--limit", "--commit", "--range", "--base", "--rev", "--order",
];
/// Flags that take none.
const BARE: [&str; 3] = ["--pretty", "--json", "--working-tree"];

impl<'a> Args<'a> {
    fn split(args: &'a [String]) -> Result<Self, UsageError> {
        let mut positionals = Vec::new();
        let mut flags = Vec::new();
        let mut rest = args.iter();
        let mut options_ended = false;
        while let Some(arg) = rest.next() {
            if arg == "--" && !options_ended {
                options_ended = true;
                continue;
            }
            if options_ended {
                positionals.push(arg.as_str());
                continue;
            }
            if let Some(flag) = arg.strip_prefix("--").map(|_| arg.as_str()) {
                if let Some((name, value)) = flag.split_once('=') {
                    if !VALUED.contains(&name) {
                        return Err(UsageError(format!("unknown option {name}")));
                    }
                    flags.push((name, Some(value)));
                } else if VALUED.contains(&flag) {
                    let value = rest
                        .next()
                        .ok_or_else(|| UsageError(format!("{flag} needs a value")))?;
                    flags.push((flag, Some(value.as_str())));
                } else if BARE.contains(&flag) {
                    flags.push((flag, None));
                } else {
                    return Err(UsageError(format!("unknown option {flag}")));
                }
            } else {
                positionals.push(arg.as_str());
            }
        }
        Ok(Self { positionals, flags })
    }

    fn value(&self, name: &str) -> Option<&'a str> {
        self.flags
            .iter()
            .rev()
            .find(|(flag, _)| *flag == name)
            .and_then(|(_, value)| *value)
    }

    fn has(&self, name: &str) -> bool {
        self.flags.iter().any(|(flag, _)| *flag == name)
    }

    fn positional(&self, index: usize, what: &str) -> Result<&'a str, UsageError> {
        self.positionals
            .get(index)
            .copied()
            .ok_or_else(|| UsageError(format!("missing {what}")))
    }

    fn at_most(&self, count: usize) -> Result<(), UsageError> {
        match self.positionals.get(count) {
            Some(extra) => Err(UsageError(format!("unexpected argument {extra}"))),
            None => Ok(()),
        }
    }
}

/// Parses the arguments after the program name; `--help` and `--version` answer wherever
/// they appear before a `--`.
pub fn parse(args: &[String]) -> Result<Parsed, UsageError> {
    for arg in args.iter().take_while(|arg| *arg != "--") {
        match arg.as_str() {
            "--help" | "-h" => return Ok(Parsed::Help),
            "--version" | "-V" => return Ok(Parsed::Version),
            _ => {}
        }
    }
    let Some(name) = args.first() else {
        return Err(UsageError("missing command".to_owned()));
    };
    match name.as_str() {
        "help" => return Ok(Parsed::Help),
        "version" => return Ok(Parsed::Version),
        _ => {}
    }
    let rest = Args::split(&args[1..])?;
    let repo = PathBuf::from(rest.positional(0, "<repo>")?);
    let pretty = rest.has("--pretty");
    let command = match name.as_str() {
        "open" => {
            rest.at_most(1)?;
            Command::Open
        }
        "refs" => {
            rest.at_most(1)?;
            Command::Refs
        }
        "log" => {
            rest.at_most(1)?;
            let scope = match rest.value("--branch") {
                Some(branch) => WalkScope::Ref {
                    name: branch.to_owned(),
                },
                None => WalkScope::All,
            };
            let limit = match rest.value("--limit") {
                Some(text) => Some(
                    text.parse::<u32>()
                        .ok()
                        .filter(|n| *n > 0)
                        .ok_or_else(|| UsageError(format!("--limit needs a count, not {text}")))?,
                ),
                None => None,
            };
            // The app's order: the first page in milliseconds whatever the history's size.
            let order = match rest.value("--order").unwrap_or("lazy") {
                "lazy" => WalkOrder::Lazy,
                "date-topo" => WalkOrder::DateTopo,
                other => {
                    return Err(UsageError(format!(
                        "--order takes lazy or date-topo, not {other}"
                    )))
                }
            };
            Command::Log {
                scope,
                limit,
                order,
            }
        }
        "status" => {
            rest.at_most(1)?;
            Command::Status
        }
        "diff" => {
            rest.at_most(1)?;
            Command::Diff {
                target: diff_target(&rest)?,
            }
        }
        "compare" => {
            rest.at_most(3)?;
            Command::Compare {
                a: rest.positional(1, "<a>")?.to_owned(),
                b: rest.positional(2, "<b>")?.to_owned(),
            }
        }
        "worktrees" => {
            rest.at_most(1)?;
            Command::Worktrees
        }
        "blob" => {
            rest.at_most(2)?;
            let at = match rest.value("--rev") {
                Some(rev) => BlobAt::Revision {
                    rev: rev.to_owned(),
                },
                None => BlobAt::WorkingTree,
            };
            Command::Blob {
                at,
                path: rest.positional(1, "<file>")?.to_owned(),
            }
        }
        other => return Err(UsageError(format!("unknown command {other}"))),
    };
    Ok(Parsed::Run(Invocation {
        command,
        repo,
        pretty,
    }))
}

/// The target of `diff` from its flags: exactly one of `--commit`, `--range`, `--working-tree`.
fn diff_target(rest: &Args<'_>) -> Result<DiffTarget, UsageError> {
    let given = [
        rest.value("--commit").is_some(),
        rest.value("--range").is_some(),
        rest.has("--working-tree"),
    ]
    .iter()
    .filter(|on| **on)
    .count();
    if given != 1 {
        return Err(UsageError(
            "diff takes one of --commit, --range or --working-tree".to_owned(),
        ));
    }
    if let Some(hash) = rest.value("--commit") {
        return Ok(DiffTarget::Commit {
            hash: hash.to_owned(),
        });
    }
    if let Some(range) = rest.value("--range") {
        let (from, to, three_dot) = match range.split_once("...") {
            Some((from, to)) => (from, to, true),
            None => match range.split_once("..") {
                Some((from, to)) => (from, to, false),
                None => {
                    return Err(UsageError(format!(
                        "--range needs <a>..<b> or <a>...<b>, not {range}"
                    )))
                }
            },
        };
        if from.is_empty() || to.is_empty() {
            return Err(UsageError(format!("--range needs both ends, not {range}")));
        }
        return Ok(DiffTarget::Range {
            from: from.to_owned(),
            to: to.to_owned(),
            three_dot,
        });
    }
    let base = match rest.value("--base").unwrap_or("head") {
        "head" => WorkingTreeBase::Head,
        "index" => WorkingTreeBase::Index,
        other => {
            return Err(UsageError(format!(
                "--base takes head or index, not {other}"
            )))
        }
    };
    Ok(DiffTarget::WorkingTree { base })
}

/// One document to stdout, indented when asked, ended by a newline.
fn document<T: Serialize>(out: &mut dyn Write, value: &T, pretty: bool) -> Result<(), Failure> {
    if pretty {
        serde_json::to_writer_pretty(&mut *out, value)?;
    } else {
        serde_json::to_writer(&mut *out, value)?;
    }
    out.write_all(b"\n")?;
    Ok(())
}

/// One NDJSON line, `"kind"` first and the value's fields after it in the engine's order,
/// streamed straight to the writer and flushed whole.
#[derive(Serialize)]
struct Line<'a, T: Serialize> {
    kind: &'static str,
    #[serde(flatten)]
    value: &'a T,
}

fn line<T: Serialize>(out: &mut dyn Write, kind: &'static str, value: &T) -> Result<(), Failure> {
    serde_json::to_writer(&mut *out, &Line { kind, value })?;
    out.write_all(b"\n")?;
    out.flush()?;
    Ok(())
}

/// The closing NDJSON line.
fn done(out: &mut dyn Write) -> Result<(), Failure> {
    out.write_all(b"{\"kind\":\"done\"}\n")?;
    out.flush()?;
    Ok(())
}

/// Points the engine's CLI at `BEGITRA_GIT` when set to something; a program that is not git
/// is the failure.
fn choose_git() -> Result<(), Failure> {
    let Some(path) = std::env::var_os("BEGITRA_GIT") else {
        return Ok(());
    };
    if path.is_empty() {
        return Ok(());
    }
    git_core::cli::set_git_executable(Some(Path::new(&path)), &Cancel::never())?;
    Ok(())
}

/// Runs one invocation, writing its result to `out`.
pub fn run(invocation: &Invocation, out: &mut dyn Write) -> Result<(), Failure> {
    choose_git()?;
    let engine = Git2Engine::open(&invocation.repo)?;
    let cancel = Cancel::never();
    let pretty = invocation.pretty;
    match &invocation.command {
        Command::Open => document(out, engine.repo(), pretty),
        Command::Refs => document(out, &engine.refs(&cancel)?, pretty),
        Command::Log {
            scope,
            limit,
            order,
        } => {
            let options = WalkOptions {
                page_size: limit.map_or(LOG_PAGE, |n| n.min(LOG_PAGE)),
                order: *order,
                ..WalkOptions::default()
            };
            let mut walk = engine.walk(scope, &options, &cancel)?;
            let mut left = limit.map(|n| n as usize);
            loop {
                let mut page = walk.next_page(&cancel)?;
                if let Some(remaining) = left.as_mut() {
                    if page.commits.len() >= *remaining {
                        page.commits.truncate(*remaining);
                        page.done = true;
                        *remaining = 0;
                    } else {
                        *remaining -= page.commits.len();
                    }
                }
                let finished = page.done;
                line(out, "page", &page)?;
                if finished {
                    break;
                }
            }
            done(out)
        }
        Command::Status => document(
            out,
            &engine.status(&StatusOptions::default(), &cancel)?,
            pretty,
        ),
        Command::Diff { target } => {
            let mut walk =
                engine.diff_pages(target, &DiffOptions::default(), DIFF_PAGE, &cancel)?;
            loop {
                let page = walk.next_page(&cancel)?;
                let finished = page.done;
                line(out, "page", &page)?;
                if finished {
                    break;
                }
            }
            done(out)
        }
        Command::Compare { a, b } => document(out, &engine.compare(a, b, &cancel)?, pretty),
        Command::Worktrees => document(out, &engine.worktrees(&cancel)?, pretty),
        Command::Blob { at, path } => document(out, &engine.read_blob(at, path)?, pretty),
    }
}

/// The whole program: parses, runs, and returns the exit status; the usage goes to `err`
/// on a usage error and to `out` for `--help`.
pub fn main_with(args: &[String], out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    match parse(args) {
        Ok(Parsed::Help) => {
            let _ = out.write_all(USAGE.as_bytes());
            0
        }
        Ok(Parsed::Version) => {
            let _ = writeln!(out, "begitra-cli {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Ok(Parsed::Run(invocation)) => match run(&invocation, out) {
            Ok(()) => 0,
            // The consumer closed the pipe: it has what it wanted, nothing to report.
            Err(failure) if failure.is_broken_pipe() => 0,
            Err(failure) => {
                let _ = serde_json::to_writer(&mut *err, &failure);
                let _ = err.write_all(b"\n");
                1
            }
        },
        Err(UsageError(problem)) => usage_error(&problem, err),
    }
}

/// Reports a usage problem before the usage on `err`; the exit status is 2.
pub fn usage_error(problem: &str, err: &mut dyn Write) -> i32 {
    let _ = writeln!(err, "begitra-cli: {problem}\n");
    let _ = err.write_all(USAGE.as_bytes());
    2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    fn run_of(list: &[&str]) -> Invocation {
        match parse(&args(list)).expect("parses") {
            Parsed::Run(invocation) => invocation,
            other => panic!("not a run: {other:?}"),
        }
    }

    #[test]
    fn commands_and_flags_are_read() {
        assert_eq!(parse(&args(&["--help"])), Ok(Parsed::Help));
        assert_eq!(parse(&args(&["-V"])), Ok(Parsed::Version));
        let refs = run_of(&["refs", "/r", "--pretty"]);
        assert_eq!(refs.command, Command::Refs);
        assert_eq!(refs.repo, PathBuf::from("/r"));
        assert!(refs.pretty);
        assert_eq!(
            run_of(&["log", "/r", "--branch", "main", "--limit=3"]).command,
            Command::Log {
                scope: WalkScope::Ref {
                    name: "main".to_owned()
                },
                limit: Some(3),
                order: WalkOrder::Lazy,
            }
        );
        assert_eq!(
            run_of(&["log", "/r", "--json", "--order", "date-topo"]).command,
            Command::Log {
                scope: WalkScope::All,
                limit: None,
                order: WalkOrder::DateTopo,
            }
        );
        // `--` ends the options; --help and --version answer anywhere before it.
        assert_eq!(
            run_of(&["blob", "--", "/r", "--weird-file"]).command,
            Command::Blob {
                at: BlobAt::WorkingTree,
                path: "--weird-file".to_owned()
            }
        );
        assert_eq!(parse(&args(&["refs", "/r", "--help"])), Ok(Parsed::Help));
        assert_eq!(parse(&args(&["refs", "/r", "--", "--version"])).ok(), None);
        assert_eq!(
            run_of(&["diff", "/r", "--range", "a...b"]).command,
            Command::Diff {
                target: DiffTarget::Range {
                    from: "a".to_owned(),
                    to: "b".to_owned(),
                    three_dot: true
                }
            }
        );
        assert_eq!(
            run_of(&["diff", "/r", "--working-tree", "--base", "index"]).command,
            Command::Diff {
                target: DiffTarget::WorkingTree {
                    base: WorkingTreeBase::Index
                }
            }
        );
        assert_eq!(
            run_of(&["compare", "/r", "main", "develop"]).command,
            Command::Compare {
                a: "main".to_owned(),
                b: "develop".to_owned()
            }
        );
        assert_eq!(
            run_of(&["blob", "/r", "src/lib.rs", "--rev", "v1"]).command,
            Command::Blob {
                at: BlobAt::Revision {
                    rev: "v1".to_owned()
                },
                path: "src/lib.rs".to_owned()
            }
        );
    }

    #[test]
    fn usage_errors_name_what_is_wrong() {
        for (list, expected) in [
            (vec![], "missing command"),
            (vec!["refs"], "missing <repo>"),
            (vec!["frobnicate", "/r"], "unknown command frobnicate"),
            (vec!["refs", "/r", "extra"], "unexpected argument extra"),
            (vec!["refs", "/r", "--colour"], "unknown option --colour"),
            (vec!["log", "/r", "--limit"], "--limit needs a value"),
            (
                vec!["log", "/r", "--limit", "0"],
                "--limit needs a count, not 0",
            ),
            (
                vec!["log", "/r", "--order", "topo"],
                "--order takes lazy or date-topo",
            ),
            (vec!["diff", "/r"], "diff takes one of"),
            (
                vec!["diff", "/r", "--commit", "a", "--working-tree"],
                "diff takes one of",
            ),
            (vec!["diff", "/r", "--range", "a"], "--range needs <a>..<b>"),
            (
                vec!["diff", "/r", "--range", "..b"],
                "--range needs both ends",
            ),
            (
                vec!["diff", "/r", "--working-tree", "--base", "tree"],
                "--base takes head or index",
            ),
            (vec!["compare", "/r", "a"], "missing <b>"),
            (vec!["blob", "/r"], "missing <file>"),
        ] {
            let error = parse(&args(&list)).expect_err(&format!("{list:?}"));
            assert!(error.0.contains(expected), "{list:?}: {}", error.0);
        }
        let mut out = Vec::new();
        let mut err = Vec::new();
        assert_eq!(main_with(&args(&["refs"]), &mut out, &mut err), 2);
        assert!(String::from_utf8_lossy(&err).contains("Usage: begitra-cli"));
        assert!(out.is_empty());
        assert_eq!(main_with(&args(&["--help"]), &mut out, &mut err), 0);
        assert!(String::from_utf8_lossy(&out).starts_with("begitra-cli:"));
    }

    #[test]
    fn a_missing_repository_is_a_failure_document_on_stderr() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut out = Vec::new();
        let mut err = Vec::new();
        let path = dir.path().to_string_lossy().into_owned();
        assert_eq!(main_with(&args(&["refs", &path]), &mut out, &mut err), 1);
        let failure: serde_json::Value = serde_json::from_slice(&err).expect("json");
        assert_eq!(failure["code"], "repo.not_found");
        assert!(out.is_empty());
    }
}
