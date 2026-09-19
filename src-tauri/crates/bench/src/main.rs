//! Benchmark tooling for Begira.
//!
//! Subcommands: `generate` (synthetic agent repository), `fetch-real` (large real repository)
//! and `report` (results as a markdown row). Only the argument parsing is wired: the
//! subcommands report that they are not implemented.

use std::process::ExitCode;

const USAGE: &str = "usage: bench <generate | fetch-real | report> [options]";

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("generate") | Some("fetch-real") | Some("report") => {
            eprintln!("bench: this subcommand is not implemented yet");
            ExitCode::FAILURE
        }
        Some("--help") | Some("-h") => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::FAILURE
        }
    }
}
