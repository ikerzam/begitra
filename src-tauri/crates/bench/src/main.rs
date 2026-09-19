//! Benchmark tooling for Begira.
//!
//! ```text
//! bench generate  [--out DIR] [--worktrees-dir DIR] [--commits N] [--branches N]
//!                 [--worktrees N] [--files N] [--seed N] [--force] [--no-gc]
//! bench fetch-real [--out DIR] [--url URL]
//! bench report     [--criterion DIR] [--commit HASH] [--machine NAME] [--date YYYY-MM-DD]
//! ```

use std::path::PathBuf;
use std::process::ExitCode;

use bench::{fetch, generate, report, repos, Error};

const USAGE: &str = "usage: bench <generate | fetch-real | report> [options]
  generate    [--out DIR] [--worktrees-dir DIR] [--commits N] [--branches N] [--worktrees N]
              [--files N] [--seed N] [--force] [--no-gc]
  fetch-real  [--out DIR] [--url URL]
  report      [--criterion DIR] [--commit HASH] [--machine NAME] [--date YYYY-MM-DD]";

/// Minimal `--key value` / `--flag` parser; no dependency needed for three subcommands.
struct Args {
    values: Vec<(String, Option<String>)>,
}

impl Args {
    fn parse(args: impl Iterator<Item = String>) -> Result<Self, Error> {
        let mut values = Vec::new();
        let mut args = args.peekable();
        while let Some(arg) = args.next() {
            let Some(key) = arg.strip_prefix("--") else {
                return Err(Error::Usage(format!("unexpected argument {arg}")));
            };
            let takes_value = !matches!(key, "force" | "no-gc");
            let value = if takes_value {
                Some(
                    args.next()
                        .ok_or_else(|| Error::Usage(format!("--{key} needs a value")))?,
                )
            } else {
                None
            };
            values.push((key.to_owned(), value));
        }
        Ok(Self { values })
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.values
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .and_then(|(_, v)| v.as_deref())
    }

    fn flag(&self, key: &str) -> bool {
        self.values.iter().any(|(k, _)| k == key)
    }

    fn number(&self, key: &str, default: u32) -> Result<u32, Error> {
        match self.get(key) {
            Some(text) => text
                .parse()
                .map_err(|_| Error::Usage(format!("--{key} must be a number, got {text}"))),
            None => Ok(default),
        }
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(Error::Usage(message)) => {
            eprintln!("bench: {message}\n{USAGE}");
            ExitCode::FAILURE
        }
        Err(error) => {
            eprintln!("bench: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), Error> {
    let mut argv = std::env::args().skip(1);
    let subcommand = argv.next();
    let args = Args::parse(argv)?;
    match subcommand.as_deref() {
        Some("generate") => {
            let defaults = generate::Config::default();
            let config = generate::Config {
                out: args.get("out").map(PathBuf::from).unwrap_or(defaults.out),
                worktrees_dir: args
                    .get("worktrees-dir")
                    .map(PathBuf::from)
                    .unwrap_or(defaults.worktrees_dir),
                commits: args.number("commits", defaults.commits)?,
                branches: args.number("branches", defaults.branches)?,
                worktrees: args.number("worktrees", defaults.worktrees)?,
                files: args.number("files", defaults.files)?,
                seed: args.number("seed", defaults.seed as u32)?.into(),
                force: args.flag("force"),
                gc: !args.flag("no-gc"),
            };
            eprintln!(
                "bench generate: {} (seed {})",
                config.out.display(),
                config.seed
            );
            let summary = generate::run(&config)?;
            print!("{summary}");
            Ok(())
        }
        Some("fetch-real") => {
            let out = args
                .get("out")
                .map(PathBuf::from)
                .unwrap_or_else(repos::real);
            let url = args
                .get("url")
                .map(str::to_owned)
                .unwrap_or_else(|| fetch::default_url().to_owned());
            eprintln!("bench fetch-real: {url} -> {}", out.display());
            match fetch::run(&out, &url)? {
                fetch::Outcome::Verified { head } => println!("verified existing clone at {head}"),
                fetch::Outcome::Cloned { head } => println!("cloned at {head}"),
            }
            Ok(())
        }
        Some("report") => {
            let criterion = args
                .get("criterion")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("target/criterion"));
            let commit = args.get("commit").unwrap_or("-");
            let machine = args.get("machine").unwrap_or("-");
            let date = args.get("date").unwrap_or("-");
            let measurements = report::read(&criterion)?;
            if measurements.is_empty() {
                eprintln!(
                    "bench report: no results under {} (run `cargo bench -p bench` first)",
                    criterion.display()
                );
            }
            print!("{}", report::rows(&measurements, date, commit, machine));
            Ok(())
        }
        Some("--help") | Some("-h") => {
            println!("{USAGE}");
            Ok(())
        }
        Some(other) => Err(Error::Usage(format!("unknown subcommand {other}"))),
        None => Err(Error::Usage("missing subcommand".to_owned())),
    }
}
