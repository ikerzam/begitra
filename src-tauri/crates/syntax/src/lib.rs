//! Token classes and declarations of source files for the diff viewer.
//!
//! [`highlight`] classifies the tokens of a file into eight classes with syntect (Sublime
//! grammars, the pure-Rust regex engine); [`symbols`] lists the declarations of a file with
//! tree-sitter for TypeScript, JavaScript, Python, Rust, Go, Java and C#. Both are pure
//! functions of a path and a text, cancellable through a callback and capped, so the app can
//! run them on a blocking thread after the diff is on screen. Nothing here knows about git.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod highlight;
pub mod symbols;

pub use highlight::{highlight, Highlight, Token, TokenClass};
pub use symbols::{symbols, Symbol, SymbolKind};

/// Largest text either function works on, in bytes; above it the result is empty.
pub const MAX_BYTES: usize = 2 * 1024 * 1024;
/// Most lines either function works on; above it the result is empty.
pub const MAX_LINES: usize = 50_000;
/// Longest line either function works on, in bytes; a longer one (minified or generated
/// content) makes the result empty, since one such line can take seconds to classify.
pub const MAX_LINE_BYTES: usize = 16 * 1024;
/// Time [`highlight`] spends on one file before returning the lines classified so far.
pub const TIME_BUDGET: std::time::Duration = std::time::Duration::from_millis(1_500);
/// Lines (or nodes) between two cancellation checks.
pub const CANCEL_EVERY: usize = 500;

/// The caller asked to stop.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("cancelled")]
pub struct Cancelled;

/// Whether `text` is within the caps: the size, the line count and the longest line.
pub fn within_caps(text: &str) -> bool {
    if text.len() > MAX_BYTES {
        return false;
    }
    let mut lines = 0usize;
    for line in text.split_inclusive('\n') {
        lines += 1;
        if lines > MAX_LINES || line.len() > MAX_LINE_BYTES {
            return false;
        }
    }
    true
}
