//! `begitra-mcp`: the agent server's entry point (see the library).

use std::process::ExitCode;

const USAGE: &str = "usage: begitra-mcp [--version | --help]

An MCP server over stdio that lets an agent read the reviews Begitra keeps and write notes
on them. An MCP client starts it; register it with Claude Code with
  claude mcp add --scope user begitra -- <path of begitra-mcp>
BEGITRA_INDEX names another index file than the app's; BEGITRA_LOG filters the log on stderr.";

fn main() -> ExitCode {
    // An argument that is not UTF-8 is an unknown one, not a panic.
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    match args.first().map(String::as_str) {
        Some("--version" | "-V") => {
            println!("begitra-mcp {}", env!("CARGO_PKG_VERSION"));
            return ExitCode::SUCCESS;
        }
        Some("--help" | "-h") => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Some(other) => {
            eprintln!("begitra-mcp: unknown argument {other}\n\n{USAGE}");
            return ExitCode::from(2);
        }
        None => {}
    }
    // Stdout carries the protocol alone: the log goes to stderr, without colours.
    let filter = tracing_subscriber::EnvFilter::try_from_env("BEGITRA_LOG")
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn"));
    // A subscriber already set (none is, in the binary) leaves the log as it is.
    let _ = tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_env_filter(filter)
        .try_init();
    match begitra_mcp::run_stdio() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("begitra-mcp: {error}");
            ExitCode::FAILURE
        }
    }
}
