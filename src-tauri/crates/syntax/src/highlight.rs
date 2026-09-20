//! Token classes per line with syntect: the syntax is picked by extension, then by the first
//! line; every scope of the stack is mapped to one of eight classes and adjacent tokens of one
//! class are merged. Only the non-plain tokens are reported: what a line does not list is
//! plain. The viewer paints comments muted and strings secondary (the interface keeps colour
//! for facts); the other classes are kept for a later, richer treatment.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use syntect::parsing::{ParseState, Scope, ScopeStack, ScopeStackOp, SyntaxReference, SyntaxSet};

use crate::{within_caps, Cancelled, CANCEL_EVERY};

/// The class of a token.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TokenClass {
    Plain,
    Comment,
    String,
    Keyword,
    Number,
    Type,
    Function,
    Punctuation,
}

/// One classified span of a line, in byte offsets.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    pub start: u32,
    pub end: u32,
    pub class: TokenClass,
}

/// The tokens of a file, one vector per line (non-plain tokens only).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    /// The syntax used, `None` when the file was not recognised or exceeded the caps.
    pub syntax: Option<String>,
    pub lines: Vec<Vec<Token>>,
}

fn syntax_set() -> &'static SyntaxSet {
    static SET: OnceLock<SyntaxSet> = OnceLock::new();
    SET.get_or_init(SyntaxSet::load_defaults_newlines)
}

/// Extensions the bundled syntaxes do not know, read with a close relative: TypeScript as
/// JavaScript (comments, strings and keywords agree), Vue and Svelte files as HTML.
fn alias(extension: &str) -> &str {
    match extension {
        "ts" | "mts" | "cts" | "tsx" | "jsx" | "mjs" | "cjs" => "js",
        "vue" | "svelte" => "html",
        "pyi" => "py",
        "kts" => "kt",
        _ => extension,
    }
}

/// The syntax for `path`, by extension, then by the first line of `text`.
fn syntax_for<'s>(set: &'s SyntaxSet, path: &str, text: &str) -> Option<&'s SyntaxReference> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let by_extension = name
        .rsplit_once('.')
        .and_then(|(_, extension)| {
            let lower = extension.to_ascii_lowercase();
            set.find_syntax_by_extension(&lower)
                .or_else(|| set.find_syntax_by_extension(alias(&lower)))
        })
        .or_else(|| set.find_syntax_by_extension(name));
    by_extension.or_else(|| {
        let first = text.lines().next().unwrap_or("");
        set.find_syntax_by_first_line(first)
    })
}

/// The class of a scope stack: the innermost scope that names a class wins.
fn class_of(stack: &ScopeStack) -> TokenClass {
    for scope in stack.as_slice().iter().rev() {
        if let Some(class) = class_of_scope(*scope) {
            return class;
        }
    }
    TokenClass::Plain
}

fn class_of_scope(scope: Scope) -> Option<TokenClass> {
    let text = scope.build_string();
    let first = text.split('.').next().unwrap_or("");
    match first {
        "comment" => Some(TokenClass::Comment),
        "string" => Some(TokenClass::String),
        "keyword" => Some(TokenClass::Keyword),
        "storage" => Some(TokenClass::Keyword),
        "constant" => Some(if text.starts_with("constant.numeric") {
            TokenClass::Number
        } else {
            TokenClass::Keyword
        }),
        "entity" => {
            if text.starts_with("entity.name.function") || text.starts_with("entity.name.tag") {
                Some(TokenClass::Function)
            } else if text.starts_with("entity.name") || text.starts_with("entity.other") {
                Some(TokenClass::Type)
            } else {
                None
            }
        }
        "support" => {
            if text.starts_with("support.function") {
                Some(TokenClass::Function)
            } else if text.starts_with("support.type") || text.starts_with("support.class") {
                Some(TokenClass::Type)
            } else {
                None
            }
        }
        "variable" => text
            .starts_with("variable.function")
            .then_some(TokenClass::Function),
        // The delimiters of a comment or a string belong to it (the scope outside them wins);
        // other punctuation (terminators, brackets) is its own class.
        "punctuation" => {
            (!text.starts_with("punctuation.definition")).then_some(TokenClass::Punctuation)
        }
        _ => None,
    }
}

/// Classifies `text` (the whole file) as `path`; `cancelled` is polled every
/// [`CANCEL_EVERY`] lines. A file over the caps or without a known syntax yields no tokens.
pub fn highlight(
    path: &str,
    text: &str,
    cancelled: &dyn Fn() -> bool,
) -> Result<Highlight, Cancelled> {
    if !within_caps(text) {
        return Ok(Highlight::default());
    }
    let set = syntax_set();
    let Some(syntax) = syntax_for(set, path, text) else {
        return Ok(Highlight::default());
    };
    if syntax.name == "Plain Text" {
        return Ok(Highlight::default());
    }
    let mut state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut lines = Vec::new();
    // The newline-aware syntaxes expect the line terminator.
    for (index, line) in split_lines(text).enumerate() {
        if index % CANCEL_EVERY == 0 && cancelled() {
            return Err(Cancelled);
        }
        let ops = match state.parse_line(line, set) {
            Ok(ops) => ops,
            // A grammar that fails mid-file leaves the rest plain rather than failing the view.
            Err(_) => break,
        };
        lines.push(classify_line(line, &ops, &mut stack));
    }
    Ok(Highlight {
        syntax: Some(syntax.name.clone()),
        lines,
    })
}

/// Lines with their terminators, as syntect's newline syntaxes expect them.
fn split_lines(text: &str) -> impl Iterator<Item = &str> {
    text.split_inclusive('\n')
}

/// Applies the ops of one line to the stack and emits the non-plain, merged tokens.
fn classify_line(line: &str, ops: &[(usize, ScopeStackOp)], stack: &mut ScopeStack) -> Vec<Token> {
    let mut tokens: Vec<Token> = Vec::new();
    let length = line.trim_end_matches(['\n', '\r']).len();
    let mut at = 0usize;
    let mut class = class_of(stack);
    for (offset, op) in ops {
        let offset = (*offset).min(length);
        if offset > at {
            push(&mut tokens, at, offset, class);
            at = offset;
        }
        let _ = stack.apply(op);
        class = class_of(stack);
    }
    if length > at {
        push(&mut tokens, at, length, class);
    }
    tokens
}

fn push(tokens: &mut Vec<Token>, start: usize, end: usize, class: TokenClass) {
    if class == TokenClass::Plain {
        return;
    }
    if let Some(last) = tokens.last_mut() {
        if last.class == class && last.end as usize == start {
            last.end = end as u32;
            return;
        }
    }
    tokens.push(Token {
        start: start as u32,
        end: end as u32,
        class,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn never() -> bool {
        false
    }

    fn classes(tokens: &[Token], line: &str) -> Vec<(TokenClass, String)> {
        tokens
            .iter()
            .map(|t| (t.class, line[t.start as usize..t.end as usize].to_owned()))
            .collect()
    }

    #[test]
    fn typescript_comments_strings_and_keywords_are_classified() {
        let text = "// note\nconst x: number = 'text'; // tail\n";
        let result = highlight("src/a.ts", text, &never).expect("not cancelled");
        // The bundled syntaxes have no TypeScript: read as JavaScript.
        assert_eq!(result.syntax.as_deref(), Some("JavaScript"));
        assert_eq!(result.lines.len(), 2);
        let first = classes(&result.lines[0], "// note");
        assert!(first.iter().all(|(class, _)| *class == TokenClass::Comment));
        assert_eq!(
            first.iter().map(|(_, s)| s.as_str()).collect::<String>(),
            "// note"
        );
        let line = "const x: number = 'text'; // tail";
        let second = classes(&result.lines[1], line);
        assert!(
            second.contains(&(TokenClass::Keyword, "const".to_owned())),
            "{second:?}"
        );
        assert!(
            second
                .iter()
                .any(|(class, s)| *class == TokenClass::String && s.contains("text")),
            "{second:?}"
        );
        assert!(
            second
                .iter()
                .any(|(class, s)| *class == TokenClass::Comment && s.contains("tail")),
            "{second:?}"
        );
        // Tokens are ordered, non-overlapping and inside the line.
        let mut end = 0;
        for token in &result.lines[1] {
            assert!(token.start >= end && token.end <= line.len() as u32);
            end = token.end;
        }
    }

    #[test]
    fn rust_and_python_are_recognised_and_numbers_and_types_classified() {
        let rust = "struct Foo;\nfn main() { let n = 42; /* c */ }\n";
        let result = highlight("src/main.rs", rust, &never).expect("ok");
        assert_eq!(result.syntax.as_deref(), Some("Rust"));
        let line = "fn main() { let n = 42; /* c */ }";
        let tokens = classes(&result.lines[1], line);
        assert!(
            tokens.contains(&(TokenClass::Number, "42".to_owned())),
            "{tokens:?}"
        );
        assert!(
            tokens.contains(&(TokenClass::Function, "main".to_owned())),
            "{tokens:?}"
        );
        let types = classes(&result.lines[0], "struct Foo;");
        assert!(
            types.contains(&(TokenClass::Type, "Foo".to_owned())),
            "{types:?}"
        );
        let python = "def f():\n    return \"s\"  # c\n";
        let result = highlight("a.py", python, &never).expect("ok");
        assert_eq!(result.syntax.as_deref(), Some("Python"));
        let tokens = classes(&result.lines[1], "    return \"s\"  # c");
        assert!(tokens.iter().any(|(c, _)| *c == TokenClass::String));
        assert!(tokens.iter().any(|(c, _)| *c == TokenClass::Comment));
    }

    #[test]
    fn unknown_files_and_oversized_files_yield_nothing_and_cancel_stops() {
        assert_eq!(
            highlight("notes.unknownext", "hello\n", &never).expect("ok"),
            Highlight::default()
        );
        let big = "x\n".repeat(60_000);
        assert_eq!(
            highlight("a.rs", &big, &never).expect("ok"),
            Highlight::default()
        );
        let shebang = "#!/usr/bin/env python3\nprint('x')\n";
        assert_eq!(
            highlight("script", shebang, &never)
                .expect("ok")
                .syntax
                .as_deref(),
            Some("Python")
        );
        assert_eq!(highlight("a.rs", "fn a() {}\n", &|| true), Err(Cancelled));
    }
}
