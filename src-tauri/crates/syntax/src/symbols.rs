//! Declarations of a file with tree-sitter: per language, the node kinds that declare a
//! function, method, class, struct, enum, interface, trait, type, module or impl block, with
//! the name from the grammar's `name` field (the `type` field of a Rust `impl`, the declarator
//! of a JavaScript `const f = () => {}`), in document order, nested declarations included.

use std::ops::ControlFlow;

use serde::{Deserialize, Serialize};
use tree_sitter::{Language, Node, ParseOptions, Parser};

use crate::{within_caps, Cancelled, CANCEL_EVERY};

/// What a declaration declares.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SymbolKind {
    /// A free function (or an arrow function bound to a `const`).
    Function,
    /// A method of a class, struct, trait or interface.
    Method,
    /// A class.
    Class,
    /// A struct (or a C# record).
    Struct,
    /// An enum.
    Enum,
    /// An interface.
    Interface,
    /// A Rust trait.
    Trait,
    /// A type alias.
    Type,
    /// A module or namespace.
    Module,
    /// A Rust `impl` block, named after its type.
    Impl,
    /// A property with a body (a getter or setter).
    Property,
    /// A constructor.
    Constructor,
}

/// One declaration and the lines it spans (1-based, inclusive).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Symbol {
    /// What the declaration declares.
    pub kind: SymbolKind,
    /// The declared name.
    pub name: String,
    /// First line of the declaration, 1-based.
    pub start_line: u32,
    /// Last line of the declaration, 1-based, inclusive.
    pub end_line: u32,
}

/// The languages with a grammar.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lang {
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Rust,
    Go,
    Java,
    CSharp,
}

impl Lang {
    fn of(path: &str) -> Option<Self> {
        let name = path.rsplit('/').next().unwrap_or(path);
        let extension = name.rsplit_once('.')?.1.to_ascii_lowercase();
        Some(match extension.as_str() {
            "ts" | "mts" | "cts" => Lang::TypeScript,
            "tsx" => Lang::Tsx,
            "js" | "mjs" | "cjs" | "jsx" => Lang::JavaScript,
            "py" | "pyi" => Lang::Python,
            "rs" => Lang::Rust,
            "go" => Lang::Go,
            "java" => Lang::Java,
            "cs" => Lang::CSharp,
            _ => return None,
        })
    }

    fn language(self) -> Language {
        match self {
            Lang::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Lang::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Lang::Python => tree_sitter_python::LANGUAGE.into(),
            Lang::Rust => tree_sitter_rust::LANGUAGE.into(),
            Lang::Go => tree_sitter_go::LANGUAGE.into(),
            Lang::Java => tree_sitter_java::LANGUAGE.into(),
            Lang::CSharp => tree_sitter_c_sharp::LANGUAGE.into(),
        }
    }

    /// The kind a node declares, if any.
    fn kind_of(self, node: &Node<'_>) -> Option<SymbolKind> {
        let kind = node.kind();
        Some(match self {
            Lang::TypeScript | Lang::Tsx | Lang::JavaScript => match kind {
                "function_declaration" | "generator_function_declaration" => SymbolKind::Function,
                "class_declaration" | "abstract_class_declaration" => SymbolKind::Class,
                "method_definition" | "method_signature" | "abstract_method_signature" => {
                    SymbolKind::Method
                }
                "interface_declaration" => SymbolKind::Interface,
                "type_alias_declaration" => SymbolKind::Type,
                "enum_declaration" => SymbolKind::Enum,
                "internal_module" | "module" => SymbolKind::Module,
                "variable_declarator" => {
                    let value = node.child_by_field_name("value")?;
                    match value.kind() {
                        "arrow_function"
                        | "function_expression"
                        | "function"
                        | "generator_function" => SymbolKind::Function,
                        "class" => SymbolKind::Class,
                        _ => return None,
                    }
                }
                _ => return None,
            },
            Lang::Python => match kind {
                "function_definition" => SymbolKind::Function,
                "class_definition" => SymbolKind::Class,
                _ => return None,
            },
            Lang::Rust => match kind {
                "function_item" | "function_signature_item" => SymbolKind::Function,
                "struct_item" | "union_item" => SymbolKind::Struct,
                "enum_item" => SymbolKind::Enum,
                "trait_item" => SymbolKind::Trait,
                "impl_item" => SymbolKind::Impl,
                "mod_item" => SymbolKind::Module,
                "type_item" => SymbolKind::Type,
                "macro_definition" => SymbolKind::Function,
                _ => return None,
            },
            Lang::Go => match kind {
                "function_declaration" => SymbolKind::Function,
                "method_declaration" => SymbolKind::Method,
                "type_spec" => SymbolKind::Type,
                _ => return None,
            },
            Lang::Java => match kind {
                "class_declaration" => SymbolKind::Class,
                "interface_declaration" | "annotation_type_declaration" => SymbolKind::Interface,
                "enum_declaration" => SymbolKind::Enum,
                "record_declaration" => SymbolKind::Struct,
                "method_declaration" => SymbolKind::Method,
                "constructor_declaration" => SymbolKind::Constructor,
                _ => return None,
            },
            Lang::CSharp => match kind {
                "class_declaration" => SymbolKind::Class,
                "struct_declaration" | "record_declaration" => SymbolKind::Struct,
                "interface_declaration" => SymbolKind::Interface,
                "enum_declaration" => SymbolKind::Enum,
                "method_declaration" | "local_function_statement" => SymbolKind::Method,
                "constructor_declaration" => SymbolKind::Constructor,
                "property_declaration" => SymbolKind::Property,
                "namespace_declaration" | "file_scoped_namespace_declaration" => SymbolKind::Module,
                _ => return None,
            },
        })
    }

    /// The name of a declaring node.
    fn name_of(self, node: &Node<'_>, text: &str) -> Option<String> {
        let field = match (self, node.kind()) {
            (Lang::Rust, "impl_item") => "type",
            _ => "name",
        };
        let name = node.child_by_field_name(field)?;
        let mut label = name.utf8_text(text.as_bytes()).ok()?.trim().to_owned();
        if self == Lang::Rust && node.kind() == "impl_item" {
            if let Some(trait_node) = node.child_by_field_name("trait") {
                if let Ok(trait_name) = trait_node.utf8_text(text.as_bytes()) {
                    label = format!("{} for {label}", trait_name.trim());
                }
            }
        }
        (!label.is_empty()).then_some(label)
    }
}

/// Parses `text` with the grammar of `lang`; `None` when the grammar cannot be loaded, the
/// parser gave up, or `cancelled` returned true while it ran (the parser polls it as it goes).
fn parse(lang: Lang, text: &str, cancelled: &dyn Fn() -> bool) -> Option<tree_sitter::Tree> {
    let mut parser = Parser::new();
    parser.set_language(&lang.language()).ok()?;
    let bytes = text.as_bytes();
    let mut progress = |_: &tree_sitter::ParseState| {
        if cancelled() {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    };
    let options = ParseOptions::new().progress_callback(&mut progress);
    parser.parse_with_options(
        &mut |offset, _| bytes.get(offset..).unwrap_or(&[]),
        None,
        Some(options),
    )
}

/// Lists the declarations of `text` as `path`; `cancelled` is polled by the parser as it
/// progresses and every [`CANCEL_EVERY`] nodes of the walk. A file of another language, over
/// the caps, or that the grammar cannot parse at all yields an empty list.
pub fn symbols(
    path: &str,
    text: &str,
    cancelled: &dyn Fn() -> bool,
) -> Result<Vec<Symbol>, Cancelled> {
    let Some(lang) = Lang::of(path) else {
        return Ok(Vec::new());
    };
    if !within_caps(text) {
        return Ok(Vec::new());
    }
    let Some(tree) = parse(lang, text, cancelled) else {
        // The parser gives nothing back when the progress callback stopped it.
        return if cancelled() {
            Err(Cancelled)
        } else {
            Ok(Vec::new())
        };
    };
    let mut found = Vec::new();
    let mut visited = 0usize;
    let mut cursor = tree.walk();
    // A pre-order walk with the cursor: down first, then to the next sibling, then up.
    loop {
        if visited.is_multiple_of(CANCEL_EVERY) && cancelled() {
            return Err(Cancelled);
        }
        visited += 1;
        let node = cursor.node();
        if let Some(kind) = lang.kind_of(&node) {
            if let Some(name) = lang.name_of(&node, text) {
                found.push(Symbol {
                    kind,
                    name,
                    start_line: node.start_position().row as u32 + 1,
                    end_line: node.end_position().row as u32 + 1,
                });
            }
        }
        if cursor.goto_first_child() {
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return Ok(found);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn never() -> bool {
        false
    }

    fn names(path: &str, text: &str) -> Vec<(SymbolKind, String, u32, u32)> {
        symbols(path, text, &never)
            .expect("not cancelled")
            .into_iter()
            .map(|s| (s.kind, s.name, s.start_line, s.end_line))
            .collect()
    }

    #[test]
    fn rust_declarations_with_their_lines() {
        let text = "struct Foo;\n\nimpl Foo {\n    fn a(&self) {}\n    fn b() {}\n}\n\nimpl Clone for Foo {\n    fn clone(&self) -> Self { Foo }\n}\n\ntrait T {}\nenum E { A }\nmod m {\n    fn inner() {}\n}\ntype Alias = u32;\n";
        let found = names("src/lib.rs", text);
        assert_eq!(
            found,
            vec![
                (SymbolKind::Struct, "Foo".to_owned(), 1, 1),
                (SymbolKind::Impl, "Foo".to_owned(), 3, 6),
                (SymbolKind::Function, "a".to_owned(), 4, 4),
                (SymbolKind::Function, "b".to_owned(), 5, 5),
                (SymbolKind::Impl, "Clone for Foo".to_owned(), 8, 10),
                (SymbolKind::Function, "clone".to_owned(), 9, 9),
                (SymbolKind::Trait, "T".to_owned(), 12, 12),
                (SymbolKind::Enum, "E".to_owned(), 13, 13),
                (SymbolKind::Module, "m".to_owned(), 14, 16),
                (SymbolKind::Function, "inner".to_owned(), 15, 15),
                (SymbolKind::Type, "Alias".to_owned(), 17, 17),
            ]
        );
    }

    #[test]
    fn typescript_javascript_and_python_declarations() {
        let ts = "export function f() {}\nconst g = () => 1;\nclass C {\n  m() {}\n}\ninterface I {}\ntype T = string;\nenum E { A }\n";
        let found = names("src/a.ts", ts);
        let kinds: Vec<(SymbolKind, &str)> =
            found.iter().map(|(k, n, _, _)| (*k, n.as_str())).collect();
        assert_eq!(
            kinds,
            vec![
                (SymbolKind::Function, "f"),
                (SymbolKind::Function, "g"),
                (SymbolKind::Class, "C"),
                (SymbolKind::Method, "m"),
                (SymbolKind::Interface, "I"),
                (SymbolKind::Type, "T"),
                (SymbolKind::Enum, "E"),
            ]
        );
        let js = "function h() {}\nconst k = function () {};\n";
        let found = names("a.js", js);
        assert_eq!(found.len(), 2);
        let py = "class A:\n    def m(self):\n        pass\n\ndef top():\n    pass\n";
        let found = names("a.py", py);
        assert_eq!(
            found,
            vec![
                (SymbolKind::Class, "A".to_owned(), 1, 3),
                (SymbolKind::Function, "m".to_owned(), 2, 3),
                (SymbolKind::Function, "top".to_owned(), 5, 6),
            ]
        );
    }

    #[test]
    fn go_java_and_csharp_declarations() {
        let go = "package p\n\ntype S struct{}\n\nfunc (s S) M() {}\n\nfunc F() {}\n";
        let found = names("a.go", go);
        let kinds: Vec<(SymbolKind, &str)> =
            found.iter().map(|(k, n, _, _)| (*k, n.as_str())).collect();
        assert_eq!(
            kinds,
            vec![
                (SymbolKind::Type, "S"),
                (SymbolKind::Method, "M"),
                (SymbolKind::Function, "F"),
            ]
        );
        let java = "class A {\n  A() {}\n  void m() {}\n}\ninterface I {}\nenum E { X }\n";
        let found = names("A.java", java);
        let kinds: Vec<(SymbolKind, &str)> =
            found.iter().map(|(k, n, _, _)| (*k, n.as_str())).collect();
        assert_eq!(
            kinds,
            vec![
                (SymbolKind::Class, "A"),
                (SymbolKind::Constructor, "A"),
                (SymbolKind::Method, "m"),
                (SymbolKind::Interface, "I"),
                (SymbolKind::Enum, "E"),
            ]
        );
        let cs = "namespace N;\nclass A {\n  public int P { get; set; }\n  void M() {}\n}\nstruct S {}\n";
        let found = names("A.cs", cs);
        let kinds: Vec<(SymbolKind, &str)> =
            found.iter().map(|(k, n, _, _)| (*k, n.as_str())).collect();
        assert_eq!(
            kinds,
            vec![
                (SymbolKind::Module, "N"),
                (SymbolKind::Class, "A"),
                (SymbolKind::Property, "P"),
                (SymbolKind::Method, "M"),
                (SymbolKind::Struct, "S"),
            ]
        );
    }

    #[test]
    fn other_languages_caps_and_cancellation() {
        assert!(names("a.md", "# title\n").is_empty());
        let big = "fn a() {}\n".repeat(60_000);
        assert!(names("a.rs", &big).is_empty());
        assert_eq!(symbols("a.rs", "fn a() {}\n", &|| true), Err(Cancelled));
        // A long line over the cap.
        let long_line = format!("const S = \"{}\";\n", "y".repeat(20_000));
        assert!(names("a.ts", &long_line).is_empty());
    }

    #[test]
    fn the_parser_polls_the_flag() {
        let text = "function f() { return 1; }\n".repeat(5_000);
        assert!(parse(Lang::TypeScript, &text, &never).is_some());
        // The parser polls after a few operations, well before a 5,000-function file ends.
        assert!(parse(Lang::TypeScript, &text, &|| true).is_none());
        assert_eq!(symbols("a.ts", &text, &|| true), Err(Cancelled));
    }
}
