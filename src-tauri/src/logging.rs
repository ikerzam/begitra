//! The log file: `tracing` records go to `<log dir>/begitra-<date>.log`,
//! one file per launch named by its UTC day (a launch that crosses midnight keeps its file;
//! the time is on every line), one line per record, written through to the file as each
//! arrives (a `Mutex<File>` is the subscriber's writer: the OS has every line before the
//! call returns, so a crash keeps what was written), the seven newest day files kept. The
//! subscriber is installed at start with the console layer (debug builds) and an empty slot
//! for the file layer, which the app fills once Tauri resolves the log folder; a panic is
//! logged before the process ends, whatever the filter says.

use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tracing_subscriber::fmt::format::{DefaultFields, Format};
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{reload, EnvFilter, Registry};

/// Day files kept in the log folder; the newest by name, since the date is the name.
pub const KEEP_FILES: usize = 7;

/// The filter when neither `BEGITRA_LOG` nor `RUST_LOG` sets one: the app, the engine, the
/// index, the updater plugin (its failures go through `log`) and Tauri's warnings.
pub const DEFAULT_FILTER: &str =
    "begitra_lib=info,git_core=info,repo_index=info,tauri_plugin_updater=info,tauri=warn";

/// The panic hook's target; its directive is added to every filter so the line survives a
/// narrow `BEGITRA_LOG` (a targeted directive wins over a bare one).
const PANIC_TARGET: &str = "begitra_lib::panic";

const PREFIX: &str = "begitra-";
const SUFFIX: &str = ".log";

/// The file layer's type: the format is fixed so the reload slot can hold `None` first.
type FileLayer = tracing_subscriber::fmt::Layer<Registry, DefaultFields, Format, Mutex<File>>;

/// The slot the file layer is loaded into once the folder is known.
pub struct LogSlot {
    handle: reload::Handle<Option<FileLayer>, Registry>,
}

/// `YYYY-MM-DD` of a Unix time (UTC), by the civil-from-days arithmetic of Howard Hinnant.
pub fn day(unix_seconds: i64) -> String {
    let days = unix_seconds.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// The day file's name for a Unix time.
pub fn file_name(unix_seconds: i64) -> String {
    format!("{PREFIX}{}{SUFFIX}", day(unix_seconds))
}

/// Seconds since the epoch now; zero when the clock is before it.
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_secs()).unwrap_or(0))
        .unwrap_or(0)
}

/// Whether a file name is a day file's (`begitra-YYYY-MM-DD.log`), so that nothing else in
/// the folder takes one of the kept slots.
fn is_day_file(name: &str) -> bool {
    let Some(date) = name
        .strip_prefix(PREFIX)
        .and_then(|rest| rest.strip_suffix(SUFFIX))
    else {
        return false;
    };
    let bytes = date.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 {
                *b == b'-'
            } else {
                b.is_ascii_digit()
            }
        })
}

/// Removes the day files beyond the `keep` newest in `dir`; returns what was removed. Files
/// with other names are left alone, and a file that cannot be removed does not stop the rest.
pub fn prune(dir: &Path, keep: usize) -> std::io::Result<Vec<PathBuf>> {
    let mut names: Vec<String> = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| is_day_file(name))
        .collect();
    names.sort();
    let excess = names.len().saturating_sub(keep);
    let mut removed = Vec::new();
    for name in names.into_iter().take(excess) {
        let path = dir.join(name);
        if fs::remove_file(&path).is_ok() {
            removed.push(path);
        }
    }
    Ok(removed)
}

/// Creates `dir`, opens today's file for appending and prunes the old ones.
pub fn open_day_file(dir: &Path, unix_seconds: i64) -> std::io::Result<(PathBuf, File)> {
    fs::create_dir_all(dir)?;
    let path = dir.join(file_name(unix_seconds));
    let file = OpenOptions::new().create(true).append(true).open(&path)?;
    let _ = prune(dir, KEEP_FILES);
    Ok((path, file))
}

/// The filter: `BEGITRA_LOG`, then `RUST_LOG`, then [`DEFAULT_FILTER`], always with the
/// panic hook's directive; a variable that does not parse is said on stderr and skipped.
pub fn filter() -> EnvFilter {
    let base = ["BEGITRA_LOG", "RUST_LOG"]
        .into_iter()
        .filter_map(|variable| std::env::var(variable).ok().map(|spec| (variable, spec)))
        .find_map(|(variable, spec)| match EnvFilter::try_new(&spec) {
            Ok(filter) => Some(filter),
            Err(error) => {
                eprintln!("begitra: {variable}={spec:?} is not a filter ({error}); ignored");
                None
            }
        })
        .unwrap_or_else(|| EnvFilter::new(DEFAULT_FILTER));
    with_panic_directive(base)
}

/// Adds the panic hook's directive to a filter.
fn with_panic_directive(filter: EnvFilter) -> EnvFilter {
    match format!("{PANIC_TARGET}=error").parse() {
        Ok(directive) => filter.add_directive(directive),
        Err(_) => filter,
    }
}

/// The file layer over an open file: no colours, the target and the time on every line.
fn file_layer(file: File) -> FileLayer {
    tracing_subscriber::fmt::layer()
        .with_writer(Mutex::new(file))
        .with_ansi(false)
        .with_target(true)
}

/// The subscriber: the empty slot for the file layer on the registry (the type the alias
/// names), the console layer when asked, and the filter last so it gates the whole stack.
fn stack(filter: EnvFilter, console: bool) -> (impl tracing::Subscriber + Send + Sync, LogSlot) {
    let (slot, handle) = reload::Layer::new(None::<FileLayer>);
    let console = console.then(|| {
        tracing_subscriber::fmt::layer()
            .with_writer(std::io::stderr)
            .with_target(true)
    });
    let subscriber = tracing_subscriber::registry()
        .with(slot)
        .with(console)
        .with(filter);
    (subscriber, LogSlot { handle })
}

/// Installs the global subscriber: the filter, the console layer in debug builds, and the
/// empty slot for the file layer. Returns `None` when a subscriber was installed already
/// (the tests, a second call), saying so on stderr.
pub fn install() -> Option<LogSlot> {
    let (subscriber, slot) = stack(filter(), cfg!(debug_assertions));
    match subscriber.try_init() {
        Ok(()) => Some(slot),
        Err(error) => {
            eprintln!("begitra: the log subscriber was not installed ({error})");
            None
        }
    }
}

impl LogSlot {
    /// Opens today's file in `dir` and starts writing records to it; the path is returned so
    /// the settings screen can name it. A failure leaves the console output in place.
    pub fn attach(&self, dir: &Path) -> std::io::Result<PathBuf> {
        let (path, file) = open_day_file(dir, now())?;
        self.handle
            .reload(Some(file_layer(file)))
            .map_err(std::io::Error::other)?;
        Ok(path)
    }
}

/// Logs a panic's message and location at `error` before the previous hook runs (which
/// prints it to stderr), so the file has the line before the process ends.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|text| (*text).to_owned())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".to_owned());
        let location = info
            .location()
            .map(|at| format!("{}:{}", at.file(), at.line()))
            .unwrap_or_default();
        tracing::error!(target: "begitra_lib::panic", location, "{message}");
        previous(info);
    }));
}

/// A file layer on a subscriber of its own, for the tests: every record reaches `file`.
#[cfg(test)]
fn file_subscriber(file: File) -> impl tracing::Subscriber + Send + Sync {
    tracing_subscriber::registry()
        .with(file_layer(file))
        .with(EnvFilter::new("trace"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_follow_the_civil_calendar() {
        assert_eq!(day(0), "1970-01-01");
        assert_eq!(day(86_399), "1970-01-01");
        assert_eq!(day(86_400), "1970-01-02");
        assert_eq!(day(951_782_400), "2000-02-29");
        assert_eq!(day(1_704_067_200), "2024-01-01");
        assert_eq!(day(1_758_499_200), "2025-09-22");
        assert_eq!(day(-1), "1969-12-31");
        assert_eq!(file_name(1_704_067_200), "begitra-2024-01-01.log");
    }

    #[test]
    fn a_record_reaches_the_file_before_the_call_returns() {
        let dir = tempfile::tempdir().expect("temp dir");
        let (path, file) = open_day_file(&dir.path().join("logs"), 1_704_067_200).expect("open");
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some("begitra-2024-01-01.log")
        );
        tracing::subscriber::with_default(file_subscriber(file), || {
            tracing::info!(repo = "/r", "opened the repository");
        });
        let content = fs::read_to_string(&path).expect("read");
        assert!(content.contains("opened the repository"), "{content}");
        assert!(content.contains("repo=\"/r\""), "{content}");
        assert!(content.contains("INFO"), "{content}");
    }

    #[test]
    fn retention_keeps_the_newest_day_files_and_nothing_else_is_touched() {
        let dir = tempfile::tempdir().expect("temp dir");
        for day in 1..=9 {
            fs::write(
                dir.path().join(format!("begitra-2024-01-{day:02}.log")),
                "x",
            )
            .expect("write");
        }
        fs::write(dir.path().join("notes.txt"), "keep").expect("write");
        // A file with the prefix but not a day's name never takes a slot.
        fs::write(dir.path().join("begitra-crash.log"), "keep").expect("write");
        let removed = prune(dir.path(), KEEP_FILES).expect("prune");
        let names: Vec<_> = removed
            .iter()
            .filter_map(|p| p.file_name().and_then(|n| n.to_str()).map(str::to_owned))
            .collect();
        assert_eq!(names, ["begitra-2024-01-01.log", "begitra-2024-01-02.log"]);
        assert!(dir.path().join("begitra-2024-01-03.log").exists());
        assert!(dir.path().join("begitra-2024-01-09.log").exists());
        assert!(dir.path().join("notes.txt").exists());
        assert!(dir.path().join("begitra-crash.log").exists());
        // Opening a day file prunes too, and appends to an existing day.
        let (path, _) = open_day_file(dir.path(), 1_704_758_400).expect("open");
        assert!(path.ends_with("begitra-2024-01-09.log"));
        assert_eq!(fs::read_to_string(&path).expect("read"), "x");
    }

    #[test]
    fn the_stack_gates_both_layers_and_the_slot_takes_the_file_later() {
        let dir = tempfile::tempdir().expect("temp dir");
        // The default filter given explicitly: the env test next door mutates the variables.
        let filter = with_panic_directive(EnvFilter::new(DEFAULT_FILTER));
        let (subscriber, slot) = stack(filter, false);
        let path = dir.path().join("logs");
        tracing::subscriber::with_default(subscriber, || {
            // Nothing is attached yet: the record goes nowhere and nothing panics.
            tracing::info!(target: "begitra_lib::early", "before the file");
            let file = slot.attach(&path).expect("attach");
            assert!(file.exists());
            tracing::info!(target: "begitra_lib::commands", repo = "/r", "after the file");
            // Outside the default filter: dropped by the outer EnvFilter.
            tracing::error!(target: "git2::odb", "libgit2 chatter");
            // The panic hook's line lands whatever the target filter says.
            install_panic_hook();
            let outcome = std::panic::catch_unwind(|| {
                panic!("a test panic with a message");
            });
            assert!(outcome.is_err());
            let content = fs::read_to_string(&file).expect("read");
            assert!(!content.contains("before the file"), "{content}");
            assert!(content.contains("after the file"), "{content}");
            assert!(content.contains("repo=\"/r\""), "{content}");
            assert!(!content.contains("libgit2 chatter"), "{content}");
            assert!(content.contains("a test panic with a message"), "{content}");
            assert!(content.contains("location="), "{content}");
        });
    }

    #[test]
    fn the_filter_prefers_the_app_variable_and_falls_back_to_the_default() {
        // The variables are process-wide: the test restores them.
        let saved: Vec<_> = ["BEGITRA_LOG", "RUST_LOG"]
            .iter()
            .map(|v| (v, std::env::var(v).ok()))
            .collect();
        std::env::set_var("BEGITRA_LOG", "git_core=trace");
        assert!(filter().to_string().contains("git_core=trace"));
        std::env::remove_var("BEGITRA_LOG");
        std::env::set_var("RUST_LOG", "warn");
        assert!(filter().to_string().contains("warn"));
        std::env::remove_var("RUST_LOG");
        // The filter prints its directives in its own order; the panic directive is always in.
        let mut printed: Vec<_> = filter().to_string().split(',').map(str::to_owned).collect();
        let mut expected: Vec<_> = DEFAULT_FILTER.split(',').map(str::to_owned).collect();
        expected.push(format!("{PANIC_TARGET}=error"));
        printed.sort();
        expected.sort();
        assert_eq!(printed, expected);
        std::env::set_var("BEGITRA_LOG", "git_core=trace");
        assert!(filter().to_string().contains("begitra_lib::panic=error"));
        std::env::remove_var("BEGITRA_LOG");
        for (variable, value) in saved {
            match value {
                Some(value) => std::env::set_var(variable, value),
                None => std::env::remove_var(variable),
            }
        }
    }
}
