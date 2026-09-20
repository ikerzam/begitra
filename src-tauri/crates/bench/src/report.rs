//! `bench report`: criterion results as markdown rows with their budget status, ready to
//! paste into a results table.

use std::path::Path;
use std::time::Duration;

use crate::{Error, Result};

/// Budget of a benchmark id (`<group>/<repository>`), `None` for a scenario without one.
pub fn budget(id: &str) -> Option<Duration> {
    let (group, repo) = id.split_once('/')?;
    let ms = match (group, repo) {
        // Refs are on the open-to-first-paint path, so they share its budget.
        ("open", _) | ("walk_first_page", _) | ("refs", _) => 300,
        ("walk_ten_pages", _) => 3_000,
        // A filter is an explicit action: first results within a second.
        ("walk_first_page_filtered", _) | ("path_history", _) => 1_000,
        ("diff_typical", _) => 100,
        // Two blobs per image diff, on the select-to-diff path of a large file.
        ("read_blob", _) => 200,
        // Highlighting runs after the rows show; symbols after the diff of one file.
        ("syntax", "highlight_large_file") => 1_000,
        // The highlighter stops itself after its 1.5 s budget with the lines done so far.
        ("syntax", "highlight_large_typescript") => 1_600,
        ("syntax", "symbols_typical") => 50,
        ("diff_large_file", _) | ("merge_base", _) => 500,
        // The comparison of two branches diverged by 2,000 commits, within 500 ms each: the
        // base with the counts, the first page of a side, the count of a short range and the
        // whole three-dot diff (the app pages it).
        ("compare", _) | ("walk_range_first_page", _) | ("count_range", _) => 500,
        ("diff_three_dot_first_page", _) => 500,
        // The merge preview runs in the background under its own banner (delegated).
        ("merge_preview", _) => 2_000,
        ("status", _) => 2_000,
        ("discovery", "scan_first_result") => 100,
        ("discovery", "scan_full") => 2_000,
        ("worktrees", "synthetic") => 50,
        ("worktrees", _) => 500,
        // The dashboard: the listing and one comparison per linked worktree.
        ("worktree_dashboard", _) => 500,
        // Adding a worktree checks out the whole tree: a user action with its progress.
        ("worktree_add_remove", _) => return None,
        _ => return None,
    };
    Some(Duration::from_millis(ms))
}

/// One measured benchmark.
#[derive(Clone, Debug, PartialEq)]
pub struct Measurement {
    /// `<group>/<repository>`.
    pub id: String,
    /// Median of the samples.
    pub median: Duration,
}

/// Reads every `new/estimates.json` under criterion's output folder.
pub fn read(criterion_dir: &Path) -> Result<Vec<Measurement>> {
    let mut measurements = Vec::new();
    if !criterion_dir.exists() {
        return Ok(measurements);
    }
    for group in std::fs::read_dir(criterion_dir).map_err(|s| Error::io("read criterion dir", s))? {
        let group = group.map_err(|s| Error::io("read criterion entry", s))?;
        if !group.path().is_dir() || group.file_name() == "report" {
            continue;
        }
        for bench in std::fs::read_dir(group.path()).map_err(|s| Error::io("read group", s))? {
            let bench = bench.map_err(|s| Error::io("read bench entry", s))?;
            let estimates = bench.path().join("new").join("estimates.json");
            if !estimates.is_file() {
                continue;
            }
            let text = std::fs::read_to_string(&estimates)
                .map_err(|s| Error::io(format!("read {}", estimates.display()), s))?;
            let json: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| Error::Report(format!("{}: {e}", estimates.display())))?;
            let nanos = json["median"]["point_estimate"]
                .as_f64()
                .ok_or_else(|| Error::Report(format!("{}: no median", estimates.display())))?;
            measurements.push(Measurement {
                id: format!(
                    "{}/{}",
                    group.file_name().to_string_lossy(),
                    bench.file_name().to_string_lossy()
                ),
                median: Duration::from_nanos(nanos as u64),
            });
        }
    }
    measurements.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(measurements)
}

/// Formats a duration for the table.
pub fn format_duration(duration: Duration) -> String {
    let ms = duration.as_secs_f64() * 1_000.0;
    if ms >= 1_000.0 {
        format!("{:.2} s", ms / 1_000.0)
    } else if ms >= 10.0 {
        format!("{ms:.0} ms")
    } else {
        format!("{ms:.2} ms")
    }
}

/// One markdown row per measurement: date, commit, machine, scenario, repository, result,
/// budget and status.
pub fn rows(measurements: &[Measurement], date: &str, commit: &str, machine: &str) -> String {
    let mut out = String::new();
    for m in measurements {
        let (scenario, repository) = m.id.split_once('/').unwrap_or((&m.id, "-"));
        let (budget_text, status) = match budget(&m.id) {
            Some(budget) => (
                format!("< {}", format_duration(budget)),
                if m.median <= budget { "ok" } else { "red" },
            ),
            None => ("-".to_owned(), "no budget"),
        };
        out.push_str(&format!(
            "| {date} | {commit} | {machine} | {scenario} | {repository} | {} | {budget_text} | {status} |\n",
            format_duration(m.median)
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_carry_the_budget_status() {
        let measurements = vec![
            Measurement {
                id: "refs/synthetic".to_owned(),
                median: Duration::from_millis(12),
            },
            Measurement {
                id: "walk_first_page/real".to_owned(),
                median: Duration::from_millis(900),
            },
            Measurement {
                id: "custom/thing".to_owned(),
                median: Duration::from_micros(1500),
            },
        ];
        let text = rows(&measurements, "2026-09-19", "abc1234", "laptop");
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(
            lines[0],
            "| 2026-09-19 | abc1234 | laptop | refs | synthetic | 12 ms | < 300 ms | ok |"
        );
        assert!(lines[1].ends_with("| 900 ms | < 300 ms | red |"));
        assert!(lines[2].ends_with("| 1.50 ms | - | no budget |"));
    }

    #[test]
    fn reads_criterion_estimates() {
        let dir = tempfile::tempdir().expect("temp");
        let bench = dir.path().join("refs").join("synthetic").join("new");
        std::fs::create_dir_all(&bench).expect("dirs");
        std::fs::write(
            bench.join("estimates.json"),
            r#"{"mean":{"point_estimate":2500000.0},"median":{"point_estimate":2000000.0}}"#,
        )
        .expect("write");
        let measurements = read(dir.path()).expect("read");
        assert_eq!(
            measurements,
            vec![Measurement {
                id: "refs/synthetic".to_owned(),
                median: Duration::from_millis(2),
            }]
        );
        assert!(read(&dir.path().join("missing")).expect("empty").is_empty());
    }
}
