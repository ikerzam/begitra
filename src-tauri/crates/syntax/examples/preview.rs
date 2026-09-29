//! Writes an HTML page of files coloured as the diff viewer colours them, with the app's own
//! tokens (`src/styles/tokens.css`) in the dark and the light theme, to check a syntax set
//! against the palette by eye.
//!
//! `cargo run -p syntax --example preview -- <out.html> <file>...`

use std::fmt::Write as _;
use std::path::Path;

use syntax::{highlight, TokenClass};

/// The app's tokens, read when the example runs so the crate builds without the frontend.
fn tokens() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../src/styles/tokens.css");
    std::fs::read_to_string(&path).unwrap_or_else(|error| {
        eprintln!("no colours: {} ({error})", path.display());
        String::new()
    })
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn class_name(class: TokenClass) -> &'static str {
    match class {
        TokenClass::Keyword => "k",
        TokenClass::Function => "f",
        TokenClass::Type => "t",
        TokenClass::String => "s",
        TokenClass::Number => "n",
        TokenClass::Comment => "c",
        TokenClass::Punctuation => "p",
        TokenClass::Plain => "",
    }
}

/// The lines of `text` as HTML, each span in its class.
fn render(path: &str, text: &str) -> (String, String) {
    let result = match highlight(path, text, &|| false) {
        Ok(result) => result,
        Err(_) => return ("cancelled".to_owned(), escape(text)),
    };
    let mut html = String::new();
    for (index, line) in text.lines().enumerate() {
        let tokens = result.lines.get(index).map(Vec::as_slice).unwrap_or(&[]);
        let mut at = 0usize;
        for token in tokens {
            let (start, end) = (token.start as usize, token.end as usize);
            if let (Some(before), Some(inside)) = (line.get(at..start), line.get(start..end)) {
                html.push_str(&escape(before));
                let _ = write!(
                    html,
                    "<span class=\"{}\">{}</span>",
                    class_name(token.class),
                    escape(inside)
                );
                at = end;
            }
        }
        html.push_str(&escape(line.get(at..).unwrap_or("")));
        html.push('\n');
    }
    let syntax = result.syntax.unwrap_or_else(|| "none".to_owned());
    let state = if result.complete { "" } else { ", cut off" };
    (format!("{syntax}{state}"), html)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(out) = args.next() else {
        eprintln!("usage: preview <out.html> <file>...");
        std::process::exit(2);
    };
    let mut sections = String::new();
    for file in args {
        let Ok(text) = std::fs::read_to_string(&file) else {
            eprintln!("skipped {file}: not readable as text");
            continue;
        };
        let name = Path::new(&file)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| file.clone());
        let (syntax, html) = render(&name, &text);
        let _ = write!(
            sections,
            "<section><h2>{} <small>{}</small></h2><pre>{}</pre></section>",
            escape(&name),
            escape(&syntax),
            html
        );
    }
    let tokens = tokens();
    let page = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>Syntax preview</title><style>{tokens}
body {{ margin: 0; display: grid; grid-template-columns: 1fr 1fr; }}
.theme {{ background: var(--bg-app); color: var(--text); padding: 16px; min-width: 0; }}
h2 {{ font: 500 13px system-ui; color: var(--text); margin: 16px 0 8px; }}
small {{ color: var(--text-secondary); font-weight: 400; }}
pre {{ font: 12px/20px ui-monospace, Consolas, monospace; margin: 0; overflow-x: auto; }}
.k {{ color: var(--syntax-keyword); }} .f {{ color: var(--syntax-function); }}
.t {{ color: var(--syntax-type); }} .s {{ color: var(--syntax-string); }}
.n {{ color: var(--syntax-number); }} .c {{ color: var(--syntax-comment); }}
.p {{ color: var(--text-secondary); }}
</style><div class=\"theme\" data-theme=\"dark\">{sections}</div><div class=\"theme\" data-theme=\"light\">{sections}</div>"
    );
    if let Err(error) = std::fs::write(&out, page) {
        eprintln!("could not write {out}: {error}");
        std::process::exit(1);
    }
}
