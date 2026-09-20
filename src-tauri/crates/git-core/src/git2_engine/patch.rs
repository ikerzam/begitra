//! The unified diff of a selection: the hunks and lines the viewer showed, with
//! the unselected changes folded away, written the way `git apply` reads it.
//!
//! A patch turns its old side into its new side. Applied forward (stage: the index takes
//! the working tree's selected lines) the file matches the old side, so an unselected
//! removed line is still there and becomes context while an unselected added line is not
//! and is dropped. Applied reversed (unstage, discard) the file matches the new side, so the
//! roles swap: an unselected added line becomes context and an unselected removed line is
//! dropped. Counts are recomputed from the lines written and the other side's start from
//! the running delta, so the header is right by construction; git then checks every context
//! line against the file and refuses a stale selection.
//!
//! One selection cannot be written: a line without a trailing newline can only be the last
//! line of its side, so the pair of lines that changes the end of a file (the old last line
//! without its newline, the new one) must be selected together, else git would join two
//! lines when it applies the marker. [`problem`] names it; the bridge refuses it before the
//! engine runs and [`build`] refuses it again.

use std::fmt::Write;

use crate::types::{ChangeKind, LineKind, PatchSelection, SelectedHunk, SelectedLine};

/// Whether a hunk takes part: at least one changed line selected.
fn takes_part(hunk: &SelectedHunk) -> bool {
    hunk.lines
        .iter()
        .any(|line| line.selected && line.kind != LineKind::Context)
}

/// Whether every changed line of the selection is selected.
pub(crate) fn is_whole(selection: &PatchSelection) -> bool {
    selection.hunks.iter().all(|hunk| {
        hunk.lines
            .iter()
            .all(|line| line.selected || line.kind == LineKind::Context)
    })
}

/// The marker a line gets in the patch, or `None` when the folding drops it.
fn marker(line: &SelectedLine, reverse: bool) -> Option<char> {
    match (line.kind, line.selected, reverse) {
        (LineKind::Context, _, _) => Some(' '),
        (LineKind::Added, true, _) => Some('+'),
        (LineKind::Removed, true, _) => Some('-'),
        // Unselected: the side the file matches keeps the line as context.
        (LineKind::Added, false, true) | (LineKind::Removed, false, false) => Some(' '),
        (LineKind::Added, false, false) | (LineKind::Removed, false, true) => None,
    }
}

/// Why `selection` cannot be written as a patch, if it cannot: a `no_newline` line that
/// would not be the last of its side (git would join it with the line after it).
pub fn problem(selection: &PatchSelection, reverse: bool) -> Option<String> {
    let hunks: Vec<&SelectedHunk> = selection.hunks.iter().filter(|h| takes_part(h)).collect();
    for (index, hunk) in hunks.iter().enumerate() {
        let last_hunk = index + 1 == hunks.len();
        let written: Vec<(char, bool)> = hunk
            .lines
            .iter()
            .filter_map(|line| marker(line, reverse).map(|m| (m, line.no_newline)))
            .collect();
        for (position, (mark, no_newline)) in written.iter().enumerate() {
            if !no_newline {
                continue;
            }
            let later = &written[position + 1..];
            let on_old = *mark != '+';
            let on_new = *mark != '-';
            let followed = later
                .iter()
                .any(|(m, _)| (on_old && *m != '+') || (on_new && *m != '-'));
            if followed || !last_hunk {
                return Some(format!(
                    "the end of {} changes without a newline; select the last line's removal and addition together",
                    selection.path
                ));
            }
        }
    }
    None
}

/// The unified diff of `selection`: `Ok(None)` when no line is selected, `Err` with the
/// reason when it cannot be written (see [`problem`]).
pub(crate) fn build(selection: &PatchSelection, reverse: bool) -> Result<Option<String>, String> {
    let hunks: Vec<&SelectedHunk> = selection.hunks.iter().filter(|h| takes_part(h)).collect();
    if hunks.is_empty() {
        return Ok(None);
    }
    if let Some(reason) = problem(selection, reverse) {
        return Err(reason);
    }
    let whole = hunks.len() == selection.hunks.len() && is_whole(selection);
    // git quotes the whole `a/path`, prefix included, when the name needs it.
    let a = quote(&format!("a/{}", selection.path));
    let b = quote(&format!("b/{}", selection.path));
    let mut out = String::new();
    let _ = writeln!(out, "diff --git {a} {b}");
    match selection.status {
        ChangeKind::Added if whole => {
            let _ = writeln!(out, "new file mode 100644");
            let _ = writeln!(out, "--- /dev/null");
            let _ = writeln!(out, "+++ {b}");
        }
        ChangeKind::Deleted if whole => {
            let _ = writeln!(out, "deleted file mode 100644");
            let _ = writeln!(out, "--- {a}");
            let _ = writeln!(out, "+++ /dev/null");
        }
        _ => {
            let _ = writeln!(out, "--- {a}");
            let _ = writeln!(out, "+++ {b}");
        }
    }
    // Lines the new side has more than the old one over the hunks written so far.
    let mut delta: i64 = 0;
    for hunk in hunks {
        let mut body = String::new();
        let mut old_count: u32 = 0;
        let mut new_count: u32 = 0;
        for line in &hunk.lines {
            let Some(marker) = marker(line, reverse) else {
                continue;
            };
            match marker {
                ' ' => {
                    old_count += 1;
                    new_count += 1;
                }
                '+' => new_count += 1,
                _ => old_count += 1,
            }
            body.push(marker);
            body.push_str(&line.text);
            body.push('\n');
            if line.no_newline {
                body.push_str("\\ No newline at end of file\n");
            }
        }
        // The side the file matches keeps every line of the hunk and the start the diff gave
        // it (the starts must belong to the lines given); the other side's start follows from
        // the running delta, with git's convention that an empty side names the line before
        // the hunk.
        let empty_old = i64::from(old_count == 0);
        let empty_new = i64::from(new_count == 0);
        let (old_start, new_start) = if reverse {
            let known = i64::from(hunk.new_start);
            (known - delta - empty_old + empty_new, known)
        } else {
            let known = i64::from(hunk.old_start);
            (known, known + delta + empty_old - empty_new)
        };
        let old_start = u32::try_from(old_start.max(0)).unwrap_or(u32::MAX);
        let new_start = u32::try_from(new_start.max(0)).unwrap_or(u32::MAX);
        let _ = writeln!(
            out,
            "@@ -{} +{} @@",
            range(old_start, old_count),
            range(new_start, new_count)
        );
        out.push_str(&body);
        delta += i64::from(new_count) - i64::from(old_count);
    }
    Ok(Some(out))
}

/// `start,count`, with the count left out when it is 1, as git prints it.
fn range(start: u32, count: u32) -> String {
    if count == 1 {
        start.to_string()
    } else {
        format!("{start},{count}")
    }
}

/// A path as `git apply` reads it: plain, or C-quoted when it holds a character git would
/// quote itself (a quote, a backslash, a control character, a non-ASCII byte).
fn quote(path: &str) -> String {
    let plain = path
        .bytes()
        .all(|byte| byte.is_ascii() && !byte.is_ascii_control() && byte != b'"' && byte != b'\\');
    if plain {
        return path.to_owned();
    }
    let mut out = String::from("\"");
    for byte in path.bytes() {
        match byte {
            b'"' => out.push_str("\\\""),
            b'\\' => out.push_str("\\\\"),
            b'\n' => out.push_str("\\n"),
            b'\t' => out.push_str("\\t"),
            b'\r' => out.push_str("\\r"),
            byte if byte.is_ascii() && !byte.is_ascii_control() => out.push(char::from(byte)),
            byte => {
                let _ = write!(out, "\\{byte:03o}");
            }
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::SelectedLine;

    fn line(kind: LineKind, text: &str, selected: bool) -> SelectedLine {
        SelectedLine {
            kind,
            text: text.to_owned(),
            no_newline: false,
            selected,
        }
    }

    fn hunk(old_start: u32, new_start: u32, lines: Vec<SelectedLine>) -> SelectedHunk {
        let old_lines = lines.iter().filter(|l| l.kind != LineKind::Added).count() as u32;
        let new_lines = lines.iter().filter(|l| l.kind != LineKind::Removed).count() as u32;
        SelectedHunk {
            old_start,
            old_lines,
            new_start,
            new_lines,
            lines,
        }
    }

    fn selection(status: ChangeKind, hunks: Vec<SelectedHunk>) -> PatchSelection {
        PatchSelection {
            path: "src/lib.rs".to_owned(),
            status,
            hunks,
        }
    }

    #[test]
    fn a_whole_hunk_is_written_as_git_prints_it() {
        let patch = build(
            &selection(
                ChangeKind::Modified,
                vec![hunk(
                    3,
                    3,
                    vec![
                        line(LineKind::Context, "a", false),
                        line(LineKind::Removed, "b", true),
                        line(LineKind::Added, "B", true),
                        line(LineKind::Added, "C", true),
                        line(LineKind::Context, "d", false),
                    ],
                )],
            ),
            false,
        )
        .expect("valid")
        .expect("selected");
        assert_eq!(
            patch,
            "diff --git a/src/lib.rs b/src/lib.rs\n--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -3,3 +3,4 @@\n a\n-b\n+B\n+C\n d\n"
        );
    }

    #[test]
    fn forward_folds_unselected_removals_into_context_and_drops_unselected_additions() {
        let patch = build(
            &selection(
                ChangeKind::Modified,
                vec![hunk(
                    1,
                    1,
                    vec![
                        line(LineKind::Removed, "a", false),
                        line(LineKind::Removed, "b", true),
                        line(LineKind::Added, "A", false),
                        line(LineKind::Added, "B", true),
                    ],
                )],
            ),
            false,
        )
        .expect("valid")
        .expect("selected");
        assert!(patch.ends_with("@@ -1,2 +1,2 @@\n a\n-b\n+B\n"), "{patch}");
    }

    #[test]
    fn reverse_swaps_the_folding() {
        let patch = build(
            &selection(
                ChangeKind::Modified,
                vec![hunk(
                    1,
                    1,
                    vec![
                        line(LineKind::Removed, "a", false),
                        line(LineKind::Removed, "b", true),
                        line(LineKind::Added, "A", false),
                        line(LineKind::Added, "B", true),
                    ],
                )],
            ),
            true,
        )
        .expect("valid")
        .expect("selected");
        assert!(patch.ends_with("@@ -1,2 +1,2 @@\n-b\n A\n+B\n"), "{patch}");
    }

    #[test]
    fn unselected_hunks_are_left_out_and_later_starts_follow_the_delta() {
        let patch = build(
            &selection(
                ChangeKind::Modified,
                vec![
                    hunk(
                        1,
                        1,
                        vec![
                            line(LineKind::Context, "x", false),
                            line(LineKind::Added, "one", true),
                            line(LineKind::Added, "two", true),
                        ],
                    ),
                    hunk(
                        10,
                        12,
                        vec![
                            line(LineKind::Context, "y", false),
                            line(LineKind::Removed, "z", false),
                        ],
                    ),
                    hunk(
                        20,
                        21,
                        vec![
                            line(LineKind::Context, "p", false),
                            line(LineKind::Removed, "q", true),
                        ],
                    ),
                ],
            ),
            false,
        )
        .expect("valid")
        .expect("selected");
        assert!(patch.contains("@@ -1 +1,3 @@\n x\n+one\n+two\n"), "{patch}");
        assert!(!patch.contains("-z"), "{patch}");
        assert!(patch.contains("@@ -20,2 +22 @@\n p\n-q\n"), "{patch}");
    }

    #[test]
    fn nothing_selected_is_no_patch() {
        assert_eq!(
            build(
                &selection(
                    ChangeKind::Modified,
                    vec![hunk(1, 1, vec![line(LineKind::Added, "a", false)])]
                ),
                false
            ),
            Ok(None)
        );
    }

    #[test]
    fn a_no_newline_line_that_is_not_the_last_of_its_side_is_refused() {
        // `a\nb` became `a\nb\nc`: the diff is ` a`, `-b\`, `+b`, `+c\`.
        let mut old_b = line(LineKind::Removed, "b", false);
        old_b.no_newline = true;
        let mut new_c = line(LineKind::Added, "c", true);
        new_c.no_newline = true;
        let lines = vec![
            line(LineKind::Context, "a", false),
            old_b,
            line(LineKind::Added, "b", false),
            new_c,
        ];
        // Only `+c` selected, forward: `-b\` folds into context before `+c`.
        let only_c = selection(ChangeKind::Modified, vec![hunk(1, 1, lines.clone())]);
        let refused = build(&only_c, false).expect_err("refused");
        assert!(refused.contains("select the last line"), "{refused}");
        assert!(problem(&only_c, false).is_some());
        // The pair selected and `+c` not: `-b\` is the last of the old side.
        let mut pair = lines.clone();
        pair[1].selected = true;
        pair[2].selected = true;
        pair[3].selected = false;
        let with_pair = selection(ChangeKind::Modified, vec![hunk(1, 1, pair)]);
        assert!(problem(&with_pair, false).is_none());
        let patch = build(&with_pair, false).expect("valid").expect("selected");
        assert!(
            patch.ends_with(" a\n-b\n\\ No newline at end of file\n+b\n"),
            "{patch}"
        );
        // Everything selected is fine in both directions.
        let mut all = lines;
        for l in &mut all {
            l.selected = true;
        }
        let whole = selection(ChangeKind::Modified, vec![hunk(1, 1, all)]);
        assert!(problem(&whole, false).is_none() && problem(&whole, true).is_none());
        // Reverse: the pair selected, `+c\` unselected becomes context after `-b\`.
        let mut reverse_pair = whole.hunks[0].lines.clone();
        reverse_pair[3].selected = false;
        let reverse = selection(ChangeKind::Modified, vec![hunk(1, 1, reverse_pair)]);
        assert!(problem(&reverse, true).is_some());
    }

    #[test]
    fn a_whole_new_file_is_a_creation_and_a_partial_one_an_edit() {
        let lines = vec![
            line(LineKind::Added, "a", true),
            line(LineKind::Added, "b", true),
        ];
        let whole = build(
            &selection(ChangeKind::Added, vec![hunk(0, 1, lines.clone())]),
            false,
        )
        .expect("valid")
        .expect("selected");
        assert!(
            whole.contains(
                "new file mode 100644\n--- /dev/null\n+++ b/src/lib.rs\n@@ -0,0 +1,2 @@\n"
            ),
            "{whole}"
        );
        let mut partial = lines;
        partial[0].selected = false;
        let edit = build(
            &selection(ChangeKind::Added, vec![hunk(0, 1, partial)]),
            true,
        )
        .expect("valid")
        .expect("selected");
        assert!(
            edit.contains("--- a/src/lib.rs\n+++ b/src/lib.rs\n@@ -1 +1,2 @@\n a\n+b\n"),
            "{edit}"
        );
    }

    #[test]
    fn no_newline_markers_follow_their_lines() {
        let mut last = line(LineKind::Added, "end", true);
        last.no_newline = true;
        let patch = build(
            &selection(
                ChangeKind::Modified,
                vec![hunk(
                    5,
                    5,
                    vec![
                        line(LineKind::Context, "c", false),
                        line(LineKind::Removed, "old", true),
                        last,
                    ],
                )],
            ),
            false,
        )
        .expect("valid")
        .expect("selected");
        assert!(
            patch.ends_with(" c\n-old\n+end\n\\ No newline at end of file\n"),
            "{patch}"
        );
    }

    #[test]
    fn odd_paths_are_quoted_like_git() {
        assert_eq!(quote("plain/path.txt"), "plain/path.txt");
        assert_eq!(quote("with space.txt"), "with space.txt");
        assert_eq!(
            quote("ünïcödé.txt"),
            "\"\\303\\274n\\303\\257c\\303\\266d\\303\\251.txt\""
        );
        assert_eq!(quote("a\"b\\c\tt"), "\"a\\\"b\\\\c\\tt\"");
    }
}
