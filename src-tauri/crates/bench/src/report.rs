//! `bench report`: criterion results as markdown rows with their budget status, ready to
//! paste into a results table.

use std::path::Path;
use std::time::Duration;

use crate::{Error, Result};

/// Budget of a benchmark id (`<group>/<repository>`), `None` for a scenario without one.
pub fn budget(id: &str) -> Option<Duration> {
    let (group, repo) = id.split_once('/')?;
    let ms = match (group, repo) {
        ("open", _) | ("walk_first_page", _) => 300,
        ("walk_ten_pages", _) => 3_000,
        ("diff_large_file", _) => 500,
        ("status", _) => 2_000,
        ("refs", "synthetic") | ("merge_base", "synthetic") | ("worktrees", "synthetic") => 50,
        ("refs", _) | ("merge_base", _) | ("worktrees", _) => 500,
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
            "| 2026-09-19 | abc1234 | laptop | refs | synthetic | 12 ms | < 50 ms | ok |"
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
