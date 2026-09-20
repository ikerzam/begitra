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

use std::fmt::Write;

use crate::types::{ChangeKind, LineKind, PatchSelection, SelectedHunk};

/// The unified diff of `selection`; `None` when no line is selected.
pub(crate) fn build(selection: &PatchSelection, reverse: bool) -> Option<String> {
    let hunks: Vec<&SelectedHunk> = selection
        .hunks
        .iter()
        .filter(|hunk| {
            hunk.lines
                .iter()
                .any(|line| line.selected && line.kind != LineKind::Context)
        })
        .collect();
    if hunks.is_empty() {
        return None;
    }
    let whole = hunks.len() == selection.hunks.len()
        && selection.hunks.iter().all(|hunk| {
            hunk.lines
                .iter()
                .all(|line| line.selected || line.kind == LineKind::Context)
        });
    let quoted = quote(&selection.path);
    let mut out = String::new();
    let _ = writeln!(out, "diff --git a/{quoted} b/{quoted}");
    match selection.status {
        ChangeKind::Added if whole => {
            let _ = writeln!(out, "new file mode 100644");
            let _ = writeln!(out, "--- /dev/null");
            let _ = writeln!(out, "+++ b/{quoted}");
        }
        ChangeKind::Deleted if whole => {
            let _ = writeln!(out, "deleted file mode 100644");
            let _ = writeln!(out, "--- a/{quoted}");
            let _ = writeln!(out, "+++ /dev/null");
        }
        _ => {
            let _ = writeln!(out, "--- a/{quoted}");
            let _ = writeln!(out, "+++ b/{quoted}");
        }
    }
    // Lines the new side has more than the old one over the hunks written so far.
    let mut delta: i64 = 0;
    for hunk in hunks {
        let mut body = String::new();
        let mut old_count: u32 = 0;
        let mut new_count: u32 = 0;
        for line in &hunk.lines {
            let marker = match (line.kind, line.selected, reverse) {
                (LineKind::Context, _, _) => ' ',
                (LineKind::Added, true, _) => '+',
                (LineKind::Removed, true, _) => '-',
                // Unselected: the side the file matches keeps the line as context.
                (LineKind::Added, false, true) | (LineKind::Removed, false, false) => ' ',
                (LineKind::Added, false, false) | (LineKind::Removed, false, true) => continue,
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
        // The side the file matches keeps the start the diff gave it (one less when the
        // folding took every line of that side, so that it names the line before, as git
        // prints an empty side); the other side's start follows from the running delta,
        // with git's convention that an empty side names the line before the hunk.
        let empty_old = i64::from(old_count == 0);
        let empty_new = i64::from(new_count == 0);
        let (old_start, new_start) = if reverse {
            let mut known = i64::from(hunk.new_start);
            if new_count == 0 && hunk.new_lines > 0 {
                known -= 1;
            }
            (known - delta - empty_old + empty_new, known)
        } else {
            let mut known = i64::from(hunk.old_start);
            if old_count == 0 && hunk.old_lines > 0 {
                known -= 1;
            }
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
    Some(out)
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
        .expect("selected");
        assert!(patch.contains("@@ -1 +1,3 @@\n x\n+one\n+two\n"), "{patch}");
        assert!(!patch.contains("-z"), "{patch}");
        assert!(patch.contains("@@ -20,2 +22 @@\n p\n-q\n"), "{patch}");
    }

    #[test]
    fn nothing_selected_is_no_patch() {
        assert!(build(
            &selection(
                ChangeKind::Modified,
                vec![hunk(1, 1, vec![line(LineKind::Added, "a", false)])]
            ),
            false
        )
        .is_none());
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
