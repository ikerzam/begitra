//! Pure diff helpers: intra-line change spans for paired removed and added lines, and the small
//! parsers for the text libgit2 hands back.
//!
//! Kept separate from the libgit2 calls so everything here is unit-tested on plain strings.

use std::ops::Range;
use std::time::Duration;

use similar::{DiffOp, DiffTag, TextDiff};

use crate::types::{DiffLine, LineKind, Span};

/// Longest line, in bytes, that gets intra-line spans; longer lines (minified code, data
/// blobs) are left without emphasis rather than diffed character by character.
pub const MAX_INTRA_LINE_BYTES: usize = 2_000;

/// Lowest [`TextDiff::ratio`] (shared characters over the total of both lines) for a pair to
/// get spans: at least half of the characters must be common to both lines.
pub const MIN_INTRA_LINE_RATIO: f32 = 0.5;

/// Time budget per line pair; when it runs out `similar` returns a coarser but valid diff.
const INTRA_LINE_TIMEOUT: Duration = Duration::from_millis(20);

/// Equal runs shorter than this many characters between two changes are shown as changed too,
/// so a replaced word reads as one span instead of fragments around a shared letter.
pub const MIN_EQUAL_RUN: usize = 3;

/// Fills the `spans` of the lines of one hunk.
///
/// Every run of removed lines that is directly followed by a run of added lines is paired
/// position by position (the extra lines of the longer run stay plain), and each pair that is
/// similar enough gets its changed byte ranges from [`intra_line_spans`].
pub fn mark_intra_line_spans(lines: &mut [DiffLine]) {
    let mut start = 0;
    while start < lines.len() {
        let removed = lines
            .iter()
            .skip(start)
            .take_while(|line| line.kind == LineKind::Removed)
            .count();
        if removed == 0 {
            start += 1;
            continue;
        }
        let split = start + removed;
        let added = lines
            .iter()
            .skip(split)
            .take_while(|line| line.kind == LineKind::Added)
            .count();
        if added > 0 {
            let Some((head, tail)) = lines.split_at_mut_checked(split) else {
                return;
            };
            let removed_run = head.get_mut(start..).unwrap_or_default();
            let added_run = tail.get_mut(..added).unwrap_or_default();
            for (old, new) in removed_run.iter_mut().zip(added_run.iter_mut()) {
                if let Some((old_spans, new_spans)) = intra_line_spans(&old.text, &new.text) {
                    old.spans = old_spans;
                    new.spans = new_spans;
                }
            }
        }
        start = split + added;
    }
}

/// Byte ranges that differ between an old and a new line, as `(old spans, new spans)`.
///
/// Returns `None` when the lines are equal, when either is empty or longer than
/// [`MAX_INTRA_LINE_BYTES`], or when fewer than half of the characters are shared
/// ([`MIN_INTRA_LINE_RATIO`]), in which case the UI shows the whole pair as changed.
pub fn intra_line_spans(old: &str, new: &str) -> Option<(Vec<Span>, Vec<Span>)> {
    if old == new
        || old.is_empty()
        || new.is_empty()
        || old.len() > MAX_INTRA_LINE_BYTES
        || new.len() > MAX_INTRA_LINE_BYTES
    {
        return None;
    }
    let old_offsets = char_offsets(old);
    let new_offsets = char_offsets(new);
    // A ratio of 0.5 needs the shorter side to hold at least a third of the longer one.
    let (short, long) = if old_offsets.len() < new_offsets.len() {
        (old_offsets.len(), new_offsets.len())
    } else {
        (new_offsets.len(), old_offsets.len())
    };
    if long > 3 * short {
        return None;
    }
    let diff = TextDiff::configure()
        .timeout(INTRA_LINE_TIMEOUT)
        .diff_chars(old, new);
    if diff.ratio() < MIN_INTRA_LINE_RATIO {
        return None;
    }
    let mut old_spans = Vec::new();
    let mut new_spans = Vec::new();
    for (old_range, new_range) in change_groups(diff.ops()) {
        old_spans.extend(span(&old_offsets, old_range));
        new_spans.extend(span(&new_offsets, new_range));
    }
    Some((old_spans, new_spans))
}

/// Character ranges of the changes, as `(old, new)` pairs, with equal runs shorter than
/// [`MIN_EQUAL_RUN`] that sit between two changes absorbed into one range. A character-level
/// diff of `one` against `two` otherwise keeps the shared `o` and marks `ne` and `tw`.
fn change_groups(ops: &[DiffOp]) -> Vec<(Range<usize>, Range<usize>)> {
    let mut groups: Vec<(Range<usize>, Range<usize>)> = Vec::new();
    // Whether the next change continues the last group: the previous op was a change, or a
    // short equal run right after one.
    let mut open = false;
    for op in ops {
        let (tag, old_range, new_range) = op.as_tag_tuple();
        if tag == DiffTag::Equal {
            open = open && old_range.len() < MIN_EQUAL_RUN;
            continue;
        }
        match groups.last_mut() {
            Some((old, new)) if open => {
                old.end = old_range.end;
                new.end = new_range.end;
            }
            _ => groups.push((old_range, new_range)),
        }
        open = true;
    }
    groups
}

/// Byte offset of every character plus the total length, so character ranges from `similar`
/// map to byte spans.
fn char_offsets(text: &str) -> Vec<u32> {
    text.char_indices()
        .map(|(offset, _)| offset as u32)
        .chain(std::iter::once(text.len() as u32))
        .collect()
}

fn span(offsets: &[u32], range: Range<usize>) -> Option<Span> {
    let start = *offsets.get(range.start)?;
    let end = *offsets.get(range.end)?;
    (end > start).then_some(Span { start, end })
}

/// Text of a diff line as the UI shows it: one trailing newline removed, invalid UTF-8
/// replaced.
pub fn line_text(content: &[u8]) -> String {
    let content = content.strip_suffix(b"\n").unwrap_or(content);
    String::from_utf8_lossy(content).into_owned()
}

/// The `@@ ... @@` header as git prints it: libgit2's header without its trailing newline.
pub fn hunk_header(header: &[u8]) -> String {
    String::from_utf8_lossy(header).trim_end().to_owned()
}

/// The percentage of a `similarity index NN%` line in a patch file header.
pub fn parse_similarity(header: &[u8]) -> Option<u8> {
    const KEY: &[u8] = b"similarity index ";
    let at = header.windows(KEY.len()).position(|window| window == KEY)?;
    let digits = header.get(at + KEY.len()..)?;
    let mut value: u32 = 0;
    let mut seen = false;
    for byte in digits.iter().take_while(|byte| byte.is_ascii_digit()) {
        value = value * 10 + u32::from(byte - b'0');
        seen = true;
    }
    seen.then(|| u8::try_from(value.min(100)).unwrap_or(100))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(kind: LineKind, text: &str) -> DiffLine {
        DiffLine {
            kind,
            old_number: None,
            new_number: None,
            text: text.to_owned(),
            spans: Vec::new(),
            no_newline: false,
        }
    }

    #[test]
    fn one_word_change_yields_one_span_per_side() {
        let (old, new) = intra_line_spans("let value = one;", "let value = two;").expect("spans");
        assert_eq!(old, [Span { start: 12, end: 15 }]);
        assert_eq!(new, [Span { start: 12, end: 15 }]);
    }

    #[test]
    fn insertion_only_marks_the_new_side() {
        let (old, new) = intra_line_spans("fn run() {}", "fn run(x: u32) {}").expect("spans");
        assert!(old.is_empty());
        assert_eq!(new, [Span { start: 7, end: 13 }]);
    }

    #[test]
    fn short_equal_runs_between_changes_are_absorbed() {
        // "name" and "title" share only the final "e", which stays outside the span.
        let (old, new) = intra_line_spans("self.name", "self.title").expect("spans");
        assert_eq!(old, [Span { start: 5, end: 8 }]);
        assert_eq!(new, [Span { start: 5, end: 9 }]);
        // Two edits separated by a run of three or more equal characters stay separate.
        let (old, new) = intra_line_spans("a + bbb + c", "x + bbb + y").expect("spans");
        assert_eq!(
            old,
            [Span { start: 0, end: 1 }, Span { start: 10, end: 11 }]
        );
        assert_eq!(
            new,
            [Span { start: 0, end: 1 }, Span { start: 10, end: 11 }]
        );
    }

    #[test]
    fn spans_are_byte_offsets_for_multibyte_text() {
        let (old, new) = intra_line_spans("día uno", "día dos").expect("spans");
        // "día " is 5 bytes: the changed word starts at byte 5 on both sides.
        assert_eq!(old, [Span { start: 5, end: 8 }]);
        assert_eq!(new, [Span { start: 5, end: 8 }]);
    }

    #[test]
    fn dissimilar_equal_empty_and_long_lines_get_no_spans() {
        assert_eq!(intra_line_spans("abcdefgh", "12345678"), None);
        assert_eq!(intra_line_spans("same", "same"), None);
        assert_eq!(intra_line_spans("", "x"), None);
        assert_eq!(intra_line_spans("a", "abcdefghijkl"), None);
        let long = "x".repeat(MAX_INTRA_LINE_BYTES + 1);
        assert_eq!(intra_line_spans(&long, "x"), None);
    }

    #[test]
    fn runs_are_paired_position_by_position() {
        let mut lines = vec![
            line(LineKind::Context, "ctx"),
            line(LineKind::Removed, "let a = 1;"),
            line(LineKind::Removed, "let b = 2;"),
            line(LineKind::Removed, "completely different"),
            line(LineKind::Added, "let a = 2;"),
            line(LineKind::Added, "let b = 30;"),
            line(LineKind::Context, "ctx"),
            line(LineKind::Added, "lonely addition"),
        ];
        mark_intra_line_spans(&mut lines);
        assert_eq!(lines[1].spans, [Span { start: 8, end: 9 }]);
        assert_eq!(lines[4].spans, [Span { start: 8, end: 9 }]);
        assert_eq!(lines[2].spans, [Span { start: 8, end: 9 }]);
        assert_eq!(lines[5].spans, [Span { start: 8, end: 10 }]);
        assert!(lines[3].spans.is_empty(), "unpaired removed line");
        assert!(lines[0].spans.is_empty() && lines[6].spans.is_empty());
        assert!(lines[7].spans.is_empty(), "added run without a removed run");
    }

    #[test]
    fn removed_run_after_an_added_run_is_not_paired() {
        let mut lines = vec![
            line(LineKind::Added, "let a = 10;"),
            line(LineKind::Removed, "let a = 1;"),
        ];
        mark_intra_line_spans(&mut lines);
        assert!(lines.iter().all(|line| line.spans.is_empty()));
    }

    #[test]
    fn line_text_strips_one_newline_only() {
        assert_eq!(line_text(b"abc\n"), "abc");
        assert_eq!(line_text(b"abc"), "abc");
        assert_eq!(line_text(b"abc\r\n"), "abc\r");
        assert_eq!(line_text(b"\n"), "");
        assert_eq!(line_text(b"\xff\n"), "\u{fffd}");
    }

    #[test]
    fn hunk_header_is_trimmed() {
        assert_eq!(
            hunk_header(b"@@ -1,3 +1,4 @@ fn main()\n"),
            "@@ -1,3 +1,4 @@ fn main()"
        );
    }

    #[test]
    fn similarity_is_read_from_the_file_header() {
        let header =
            b"diff --git a/old b/new\nsimilarity index 90%\nrename from old\nrename to new\n";
        assert_eq!(parse_similarity(header), Some(90));
        assert_eq!(parse_similarity(b"similarity index 100%\n"), Some(100));
        assert_eq!(parse_similarity(b"similarity index 250%\n"), Some(100));
        assert_eq!(parse_similarity(b"diff --git a/x b/x\n"), None);
        assert_eq!(parse_similarity(b"similarity index %\n"), None);
    }
}
