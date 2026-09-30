//! Token classes per line with syntect and the `bat` project's syntax set (`two-face`): the
//! syntax is picked by the whole file name, then by extension, then by the first line; every
//! scope of the stack is mapped to one of eight classes (each scope's name read once per file)
//! and adjacent tokens of one class are merged. Only the non-plain tokens are reported: what a
//! line does not list is plain. The viewer paints six classes in the `--syntax-*` colour tokens
//! and punctuation in `--text-secondary`.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use syntect::parsing::{ParseState, Scope, ScopeStack, ScopeStackOp, SyntaxReference, SyntaxSet};

use crate::{within_caps, Cancelled, CANCEL_EVERY, TIME_BUDGET};

/// The class of a token.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TokenClass {
    /// Anything not listed below; never reported, since a line's gaps are plain.
    Plain,
    /// A comment, with its delimiters.
    Comment,
    /// A string literal, with its quotes.
    String,
    /// A keyword, a storage modifier, a language constant or an escape.
    Keyword,
    /// A numeric literal.
    Number,
    /// A type name.
    Type,
    /// A function or method name, at its declaration or call.
    Function,
    /// Punctuation and operators.
    Punctuation,
}

/// One classified span of a line, in byte offsets.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Token {
    /// First byte of the span.
    pub start: u32,
    /// One past the last byte of the span.
    pub end: u32,
    /// The class of the span.
    pub class: TokenClass,
}

/// The tokens of a file, one vector per line (non-plain tokens only).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    /// The syntax used, `None` when the file was not recognised or exceeded the caps.
    pub syntax: Option<String>,
    /// The non-plain tokens of each line, in order; a line without an entry (the time budget
    /// ran out, or the grammar failed mid-file) is plain.
    pub lines: Vec<Vec<Token>>,
    /// Whether the file was classified to its end; `false` when [`TIME_BUDGET`] ran out
    /// first or the grammar failed mid-file. A file with nothing to classify (no known syntax,
    /// over the caps, binary) is complete.
    pub complete: bool,
}

impl Highlight {
    /// The answer for a file with nothing to classify (no known syntax, over the caps, binary):
    /// no syntax, no tokens, and nothing left to compute, so it is cached like any other.
    pub fn nothing() -> Self {
        Highlight {
            syntax: None,
            lines: Vec::new(),
            complete: true,
        }
    }
}

/// The syntax set, loaded once: the `bat` project's, which holds syntect's own and TypeScript,
/// TSX, JSX, Vue, Svelte, TOML, Dockerfile and the rest.
fn syntax_set() -> &'static SyntaxSet {
    static SET: OnceLock<SyntaxSet> = OnceLock::new();
    SET.get_or_init(two_face::syntax::extra_newlines)
}

/// The syntaxes whose grammars [`warm_up`] unpacks after the set: the languages most diffs are
/// in.
pub const WARM_SYNTAXES: [&str; 10] = [
    "TypeScript",
    "TypeScriptReact",
    "JavaScript (Babel)",
    "Vue Component",
    "Markdown",
    "Rust",
    "Python",
    "JSON",
    "YAML",
    "CSS",
];

/// Loads the syntax set now, with the grammars of the most common languages (a parse state
/// unpacks its syntax's contexts, which the set keeps compressed), so the first file
/// highlighted does not wait for them.
pub fn warm_up() {
    let started = Instant::now();
    let set = syntax_set();
    for name in WARM_SYNTAXES {
        if let Some(syntax) = set.find_syntax_by_name(name) {
            let _ = ParseState::new(syntax);
        }
    }
    tracing::debug!(elapsed = ?started.elapsed(), "syntax set loaded");
}

/// The syntax for an extension the set would give a rarer language: a `.h` header is read as
/// C++, which reads C too (the set's reverse search picks Objective-C).
fn preferred<'s>(set: &'s SyntaxSet, extension: &str) -> Option<&'s SyntaxReference> {
    if extension.eq_ignore_ascii_case("h") {
        set.find_syntax_by_name("C++")
    } else {
        None
    }
}

/// The syntax for `path`, as `bat` looks it up: by the whole file name (`Dockerfile`,
/// `CMakeLists.txt`, `.gitignore`), then by extension, then by the first line of `text`; the
/// set compares both without case.
fn syntax_for<'s>(set: &'s SyntaxSet, path: &str, text: &str) -> Option<&'s SyntaxReference> {
    let name = path.rsplit('/').next().unwrap_or(path);
    let extension = name.rsplit_once('.').map(|(_, extension)| extension);
    extension
        .and_then(|extension| preferred(set, extension))
        .or_else(|| set.find_syntax_by_extension(name))
        .or_else(|| extension.and_then(|extension| set.find_syntax_by_extension(extension)))
        .or_else(|| set.find_syntax_by_first_line(text.lines().next().unwrap_or("")))
}

/// What one scope says about the class of the token under it.
#[derive(Clone, Copy)]
enum Named {
    /// A class, and whether the scope is an operator's, whose class also depends on its text
    /// (see [`worded`]).
    Class(TokenClass, bool),
    /// A section's name (a C# region, a Git config section, a Markdown heading's text): the
    /// class of a scope further out, a Markdown heading's, else a type.
    Section,
    /// No class: a scope further out decides.
    Nothing,
}

fn named(text: &str) -> Named {
    if text.starts_with("entity.name.section") {
        return Named::Section;
    }
    match class_named(text) {
        // JavaScript scopes `=>` as the storage of a function, the others their operators as
        // `keyword.operator`.
        Some(class) => Named::Class(
            class,
            text.starts_with("keyword.operator") || text.starts_with("storage.type.function"),
        ),
        None => Named::Nothing,
    }
}

/// The classes the scopes of one file name, each scope's name built once: building it takes
/// syntect's global scope lock and an allocation, and a file meets the same few scopes on
/// every line.
#[derive(Default)]
struct Classifier {
    named: HashMap<Scope, Named>,
}

impl Classifier {
    /// The class of a scope stack (the innermost scope that names a class wins, a section's
    /// name falling back to a type) and whether that scope is an operator's.
    fn class_of(&mut self, stack: &ScopeStack) -> (TokenClass, bool) {
        let mut fallback = TokenClass::Plain;
        for scope in stack.as_slice().iter().rev() {
            let said = *self
                .named
                .entry(*scope)
                .or_insert_with(|| named(&scope.build_string()));
            match said {
                Named::Class(class, operator) => return (class, operator),
                Named::Section => fallback = TokenClass::Type,
                Named::Nothing => {}
            }
        }
        (fallback, false)
    }
}

fn class_named(text: &str) -> Option<TokenClass> {
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
            // A JSX or TSX component's tag takes the tag class, as HTML's tags do.
            if text.starts_with("support.function") || text.starts_with("support.class.component") {
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
        // Markdown: a heading in the keyword colour and inline code in the string colour; a
        // fence's code keeps its own language's classes, the fence itself naming none.
        "markup" => {
            if text.starts_with("markup.heading") {
                Some(TokenClass::Keyword)
            } else if text.starts_with("markup.raw.inline") {
                Some(TokenClass::String)
            } else {
                None
            }
        }
        // The delimiters of a comment or a string belong to it (the scope outside them wins);
        // other punctuation (terminators, brackets) is its own class.
        "punctuation" => {
            (!text.starts_with("punctuation.definition")).then_some(TokenClass::Punctuation)
        }
        _ => None,
    }
}

/// Classifies `text` (the whole file) as `path`; `cancelled` is polled every
/// [`CANCEL_EVERY`] lines, and the work stops after [`TIME_BUDGET`] with the lines done so
/// far (`complete` false). A file over the caps or without a known syntax yields no tokens.
pub fn highlight(
    path: &str,
    text: &str,
    cancelled: &dyn Fn() -> bool,
) -> Result<Highlight, Cancelled> {
    highlight_within(path, text, cancelled, TIME_BUDGET)
}

/// [`highlight`] with its own time budget, counted from the moment the syntax's grammar is
/// loaded: loading it is the syntax's first use in the process, not this file's work.
pub fn highlight_within(
    path: &str,
    text: &str,
    cancelled: &dyn Fn() -> bool,
    budget: Duration,
) -> Result<Highlight, Cancelled> {
    if !within_caps(text) {
        return Ok(Highlight::nothing());
    }
    let set = syntax_set();
    let Some(syntax) = syntax_for(set, path, text) else {
        return Ok(Highlight::nothing());
    };
    if syntax.name == "Plain Text" {
        return Ok(Highlight::nothing());
    }
    let mut state = ParseState::new(syntax);
    let started = Instant::now();
    let mut stack = ScopeStack::new();
    let mut classifier = Classifier::default();
    let mut lines = Vec::new();
    let mut complete = true;
    // The newline-aware syntaxes expect the line terminator.
    for (index, line) in split_lines(text).enumerate() {
        if index % CANCEL_EVERY == 0 {
            if cancelled() {
                return Err(Cancelled);
            }
            if index > 0 && started.elapsed() > budget {
                complete = false;
                break;
            }
        }
        let ops = match state.parse_line(line, set) {
            Ok(ops) => ops,
            // A grammar that fails mid-file leaves the rest plain rather than failing the view.
            Err(_) => {
                complete = false;
                break;
            }
        };
        let mut tokens = classify_line(line, &ops, &mut stack, &mut classifier);
        tokens.shrink_to_fit();
        lines.push(tokens);
    }
    Ok(Highlight {
        syntax: Some(syntax.name.clone()),
        lines,
        complete,
    })
}

/// Lines with their terminators, as syntect's newline syntaxes expect them.
fn split_lines(text: &str) -> impl Iterator<Item = &str> {
    text.split_inclusive('\n')
}

/// Applies the ops of one line to the stack and emits the non-plain, merged tokens.
fn classify_line(
    line: &str,
    ops: &[(usize, ScopeStackOp)],
    stack: &mut ScopeStack,
    classifier: &mut Classifier,
) -> Vec<Token> {
    let mut tokens: Vec<Token> = Vec::new();
    let length = line.trim_end_matches(['\n', '\r']).len();
    let mut at = 0usize;
    let mut class = classifier.class_of(stack);
    let class_at =
        |(class, operator): (TokenClass, bool), from: usize, to: usize| match line.get(from..to) {
            Some(text) if operator => worded(class, text),
            _ => class,
        };
    for (offset, op) in ops {
        let offset = (*offset).min(length);
        if offset > at {
            push(&mut tokens, at, offset, class_at(class, at, offset));
            at = offset;
        }
        let _ = stack.apply(op);
        class = classifier.class_of(stack);
    }
    if length > at {
        push(&mut tokens, at, length, class_at(class, at, length));
    }
    tokens
}

/// An operator is a keyword only when it is a word: without a letter (`=`, `&&`, `=>`, `?`)
/// it is punctuation, so the keyword colour marks `const`, `new` and `and` rather than every
/// assignment and arrow. Only operators are judged this way: an escape (`\\`), a CSS at-rule
/// (`@media`) or a C# directive (`#region`) keeps the class its scope gives it.
fn worded(class: TokenClass, text: &str) -> TokenClass {
    if class == TokenClass::Keyword && !text.chars().any(char::is_alphabetic) {
        TokenClass::Punctuation
    } else {
        class
    }
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
        assert_eq!(result.syntax.as_deref(), Some("TypeScript"));
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
    fn keywords_are_words_and_operators_punctuation() {
        let text = "const x = new Foo() && typeof y;\nconst f = () => 1;\n";
        let result = highlight("src/a.ts", text, &never).expect("not cancelled");
        let tokens = classes(&result.lines[0], "const x = new Foo() && typeof y;");
        for word in ["const", "new", "typeof"] {
            assert!(
                tokens.contains(&(TokenClass::Keyword, word.to_owned())),
                "{word}: {tokens:?}"
            );
        }
        for (class, text) in &tokens {
            if *class == TokenClass::Keyword {
                assert!(
                    text.chars().any(char::is_alphabetic),
                    "{text:?}: {tokens:?}"
                );
            }
        }
        for operator in ["=", "&&"] {
            assert!(
                tokens
                    .iter()
                    .any(|(class, s)| *class == TokenClass::Punctuation && s.contains(operator)),
                "{operator}: {tokens:?}"
            );
        }
        let arrow = classes(&result.lines[1], "const f = () => 1;");
        assert!(
            arrow
                .iter()
                .any(|(class, s)| *class == TokenClass::Punctuation && s.contains("=>")),
            "{arrow:?}"
        );
        let python = highlight("a.py", "x = a and b\n", &never).expect("ok");
        let tokens = classes(&python.lines[0], "x = a and b");
        assert!(
            tokens.contains(&(TokenClass::Keyword, "and".to_owned())),
            "{tokens:?}"
        );
    }

    #[test]
    fn only_operators_lose_the_keyword_class() {
        // Escapes are constants, and a word that starts with a symbol stays whole.
        let line = r#"const s = "a\\b\"c";"#;
        let result = highlight("a.js", &format!("{line}\n"), &never).expect("ok");
        let tokens = classes(&result.lines[0], line);
        for escape in [r"\\", r#"\""#] {
            assert!(
                tokens.contains(&(TokenClass::Keyword, escape.to_owned())),
                "{escape}: {tokens:?}"
            );
        }
        let css = highlight("a.css", "@media screen { a { color: red; } }\n", &never).expect("ok");
        let tokens = classes(&css.lines[0], "@media screen { a { color: red; } }");
        assert!(
            tokens.contains(&(TokenClass::Keyword, "@media".to_owned())),
            "{tokens:?}"
        );
        let csharp = highlight("A.cs", "#region Tiles\n", &never).expect("ok");
        let tokens = classes(&csharp.lines[0], "#region Tiles");
        assert!(
            !tokens
                .iter()
                .any(|(class, s)| *class == TokenClass::Punctuation && s == "#"),
            "{tokens:?}"
        );
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
            Highlight::nothing()
        );
        let big = "x\n".repeat(60_000);
        assert_eq!(
            highlight("a.rs", &big, &never).expect("ok"),
            Highlight::nothing()
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

    #[test]
    fn byte_and_line_caps_and_late_cancellation() {
        // Over 2 MB in few lines.
        let wide = format!("{}\n", "x".repeat(10_000)).repeat(220);
        assert_eq!(
            highlight("a.rs", &wide, &never).expect("ok"),
            Highlight::nothing()
        );
        // One line over 16 KB.
        let long_line = format!("let s = \"{}\";\n", "y".repeat(20_000));
        assert_eq!(
            highlight("a.rs", &long_line, &never).expect("ok"),
            Highlight::nothing()
        );
        // A cancel raised after the first check is seen at the next one.
        let calls = std::cell::Cell::new(0usize);
        let later = || {
            calls.set(calls.get() + 1);
            calls.get() > 1
        };
        let text = "fn a() {}\n".repeat(1_200);
        assert_eq!(highlight("a.rs", &text, &later), Err(Cancelled));
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn complete_is_reported() {
        let result = highlight("a.rs", "fn a() {}\n", &never).expect("ok");
        assert!(result.complete);
        assert_eq!(result.lines.len(), 1);
    }

    /// The classes of the only line of `text` highlighted as `path`, with the syntax used.
    fn line_classes(path: &str, line: &str) -> (Option<String>, Vec<(TokenClass, String)>) {
        let result = highlight(path, &format!("{line}\n"), &never).expect("ok");
        let tokens = result
            .lines
            .first()
            .map(|t| classes(t, line))
            .unwrap_or_default();
        (result.syntax, tokens)
    }

    fn has(tokens: &[(TokenClass, String)], class: TokenClass, text: &str) -> bool {
        tokens.iter().any(|(c, s)| *c == class && s == text)
    }

    #[test]
    fn typescript_types_have_their_classes() {
        let line = "interface Tile<T> { key: string; load(): Promise<T> }";
        let (syntax, tokens) = line_classes("src/tile.ts", line);
        assert_eq!(syntax.as_deref(), Some("TypeScript"));
        assert!(has(&tokens, TokenClass::Keyword, "interface"), "{tokens:?}");
        for name in ["Tile", "string", "Promise"] {
            assert!(has(&tokens, TokenClass::Type, name), "{name}: {tokens:?}");
        }
        assert!(has(&tokens, TokenClass::Function, "load"), "{tokens:?}");
    }

    #[test]
    fn tsx_markup_has_tag_and_attribute_classes() {
        let line = "return <Button onClick={go}>Save</Button>;";
        let (syntax, tokens) = line_classes("src/Save.tsx", line);
        assert!(
            syntax.as_deref().is_some_and(|s| s.contains("TypeScript")),
            "{syntax:?}"
        );
        assert!(has(&tokens, TokenClass::Keyword, "return"), "{tokens:?}");
        let tags = tokens
            .iter()
            .filter(|(c, s)| *c == TokenClass::Function && s == "Button")
            .count();
        assert_eq!(tags, 2, "{tokens:?}");
        assert!(has(&tokens, TokenClass::Type, "onClick"), "{tokens:?}");
        assert!(
            !tokens.iter().any(|(_, s)| s.contains("Save")),
            "{tokens:?}"
        );
    }

    #[test]
    fn a_vue_files_script_is_typescript() {
        let text = "<template><p>{{ total }}</p></template>\n<script setup lang=\"ts\">\nconst total: number = 0;\n</script>\n";
        let result = highlight("src/Total.vue", text, &never).expect("ok");
        let open = classes(&result.lines[1], "<script setup lang=\"ts\">");
        assert!(has(&open, TokenClass::Function, "script"), "{open:?}");
        let line = "const total: number = 0;";
        let tokens = classes(&result.lines[2], line);
        assert!(has(&tokens, TokenClass::Keyword, "const"), "{tokens:?}");
        assert!(has(&tokens, TokenClass::Type, "number"), "{tokens:?}");
        assert!(has(&tokens, TokenClass::Number, "0"), "{tokens:?}");
    }

    #[test]
    fn markdown_headings_inline_code_and_fences() {
        let text = "# Tiles\nCall `load()` first.\n```rust\nfn main() {}\n```\n";
        let result = highlight("docs/tiles.md", text, &never).expect("ok");
        let heading = classes(&result.lines[0], "# Tiles");
        assert!(
            has(&heading, TokenClass::Keyword, "Tiles")
                || heading
                    .iter()
                    .any(|(c, s)| *c == TokenClass::Keyword && s.contains("Tiles")),
            "{heading:?}"
        );
        let inline = classes(&result.lines[1], "Call `load()` first.");
        assert!(
            inline
                .iter()
                .any(|(c, s)| *c == TokenClass::String && s.contains("load()")),
            "{inline:?}"
        );
        let code = classes(&result.lines[3], "fn main() {}");
        assert!(has(&code, TokenClass::Keyword, "fn"), "{code:?}");
        assert!(has(&code, TokenClass::Function, "main"), "{code:?}");
    }

    #[test]
    fn files_known_by_name() {
        let (syntax, tokens) = line_classes("Dockerfile", "FROM node:20 AS build");
        assert!(syntax.is_some(), "no syntax for a Dockerfile");
        for word in ["FROM", "AS"] {
            assert!(
                has(&tokens, TokenClass::Keyword, word),
                "{word}: {tokens:?}"
            );
        }
        let (syntax, _) = line_classes("CMakeLists.txt", "cmake_minimum_required(VERSION 3.20)");
        assert_eq!(syntax.as_deref(), Some("CMake"));
        let (syntax, _) = line_classes("requirements.txt", "requests==2.32.0");
        assert!(
            syntax.as_deref().is_some_and(|s| s != "Plain Text"),
            "{syntax:?}"
        );
        let line = "version = \"0.4.0\"";
        let (syntax, tokens) = line_classes("Cargo.toml", line);
        assert_eq!(syntax.as_deref(), Some("TOML"));
        assert!(
            tokens.iter().any(|(_, s)| s == "version"),
            "version stays plain: {tokens:?}"
        );
        assert!(
            tokens
                .iter()
                .any(|(c, s)| *c == TokenClass::String && s.contains("0.4.0")),
            "{tokens:?}"
        );
    }

    #[test]
    fn headers_are_read_as_cpp() {
        let (syntax, tokens) = line_classes("include/area.h", "static inline int area(int w);");
        assert_eq!(syntax.as_deref(), Some("C++"));
        assert!(has(&tokens, TokenClass::Keyword, "static"), "{tokens:?}");
        let (_, tokens) = line_classes("include/Tile.h", "namespace geo { class Tile; }");
        assert!(has(&tokens, TokenClass::Keyword, "namespace"), "{tokens:?}");
    }

    #[test]
    fn section_names_are_types_unless_a_heading() {
        let (_, tokens) = line_classes("Tiles.cs", "#region Tiles");
        assert!(has(&tokens, TokenClass::Type, "Tiles"), "{tokens:?}");
        let (syntax, tokens) = line_classes(".gitconfig", "[core]");
        assert!(syntax.is_some(), "no syntax for .gitconfig");
        assert!(has(&tokens, TokenClass::Type, "core"), "{tokens:?}");
        let heading = line_classes("README.md", "# Tiles").1;
        assert!(
            heading
                .iter()
                .any(|(c, s)| *c == TokenClass::Keyword && s.contains("Tiles")),
            "{heading:?}"
        );
    }

    #[test]
    fn a_budget_stops_the_work_with_the_lines_done() {
        let text = "fn a() {}\n".repeat(1_200);
        let result = highlight_within("a.rs", &text, &never, Duration::ZERO).expect("ok");
        assert!(!result.complete);
        assert_eq!(result.lines.len(), CANCEL_EVERY);
    }

    #[test]
    fn the_set_loads_once() {
        warm_up();
        let first: *const SyntaxSet = syntax_set();
        warm_up();
        assert!(std::ptr::eq(first, syntax_set()));
        assert!(syntax_set().find_syntax_by_name("TypeScript").is_some());
    }

    #[test]
    fn unknown_files_answer_complete() {
        let result = highlight("notes.unknownext", "hello\n", &never).expect("ok");
        assert_eq!(result.syntax, None);
        assert!(result.lines.is_empty());
        assert!(result.complete, "nothing is left to compute");
    }
}
