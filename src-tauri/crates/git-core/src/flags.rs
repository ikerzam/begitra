//! File flag heuristics: generated, test and large files.
//!
//! Pure path and size rules, unit-tested on strings. The `linguist-generated` attribute lookup
//! that completes `is_generated` lives in the engine because it needs the repository; the rules
//! here are what remains when the attribute is unspecified.

/// Lockfile names that count as generated.
const LOCKFILES: &[&str] = &[
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.lock",
    "go.sum",
    "poetry.lock",
    "Pipfile.lock",
    "Gemfile.lock",
    "composer.lock",
    "bun.lock",
    "bun.lockb",
];

/// Suffixes of minified, bundled and source-map files that count as generated.
const MINIFIED_SUFFIXES: &[&str] = &[".min.js", ".min.css", ".bundle.js", ".map"];

/// Directory names (compared case-insensitively) that mark everything below them as tests.
const TEST_DIRS: &[&str] = &[
    "test",
    "tests",
    "__tests__",
    "spec",
    "specs",
    "testing",
    "fixtures",
];

/// Changed lines (additions plus deletions) above which a file is large.
pub const LARGE_LINES: u32 = 5_000;

/// Size in bytes above which either side of a file makes it large (1 MiB).
pub const LARGE_BYTES: u64 = 1_048_576;

/// Last segment of a repository-relative path.
pub fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Whether the path is one of the known lockfiles.
pub fn is_lockfile(path: &str) -> bool {
    let name = file_name(path);
    LOCKFILES.contains(&name)
}

/// Whether the path looks minified or bundled (`*.min.js`, `*.min.css`, `*.bundle.js`, `*.map`).
pub fn is_minified(path: &str) -> bool {
    let name = file_name(path);
    MINIFIED_SUFFIXES
        .iter()
        .any(|suffix| name.len() > suffix.len() && name.ends_with(suffix))
}

/// The name-based half of `is_generated`: a lockfile or a minified file.
pub fn is_generated_by_name(path: &str) -> bool {
    is_lockfile(path) || is_minified(path)
}

/// Whether the path is a test by convention: a directory segment `test`, `tests`, `__tests__`,
/// `spec`, `specs`, `testing` or `fixtures`, or a file name matching `*.test.*`, `*.spec.*`,
/// `*_test.go`, `*_test.rs`, `test_*.py`, `*Test.java` or `*Tests.cs`.
pub fn is_test(path: &str) -> bool {
    let mut segments = path.split('/').filter(|segment| !segment.is_empty());
    let Some(name) = segments.next_back() else {
        return false;
    };
    if segments.any(|dir| TEST_DIRS.iter().any(|test| dir.eq_ignore_ascii_case(test))) {
        return true;
    }
    is_test_file_name(name)
}

fn is_test_file_name(name: &str) -> bool {
    let parts: Vec<&str> = name.split('.').collect();
    let inner = parts.iter().skip(1).take(parts.len().saturating_sub(2));
    if inner
        .into_iter()
        .any(|part| *part == "test" || *part == "spec")
    {
        return true;
    }
    name.ends_with("_test.go")
        || name.ends_with("_test.rs")
        || (name.starts_with("test_") && name.ends_with(".py"))
        || name.ends_with("Test.java")
        || name.ends_with("Tests.cs")
}

/// Whether a change is large: over [`LARGE_LINES`] changed lines or over [`LARGE_BYTES`] on
/// either side.
pub fn is_large(changed_lines: u32, old_size: u64, new_size: u64) -> bool {
    changed_lines > LARGE_LINES || old_size > LARGE_BYTES || new_size > LARGE_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lockfiles_and_minified_files_are_generated() {
        for path in [
            "package-lock.json",
            "web/pnpm-lock.yaml",
            "yarn.lock",
            "Cargo.lock",
            "go.sum",
            "poetry.lock",
            "Pipfile.lock",
            "Gemfile.lock",
            "composer.lock",
            "bun.lock",
            "bun.lockb",
            "dist/app.min.js",
            "dist/app.min.css",
            "dist/app.bundle.js",
            "dist/app.js.map",
        ] {
            assert!(is_generated_by_name(path), "{path}");
        }
        for path in [
            "src/lib.rs",
            "Cargo.toml",
            "package.json",
            "src/minimal.js",
            "docs/map",
            ".map",
            "notes/lock",
        ] {
            assert!(!is_generated_by_name(path), "{path}");
        }
    }

    #[test]
    fn test_paths_are_recognised() {
        for path in [
            "tests/unit.rs",
            "src/__tests__/app.ts",
            "spec/models/user.rb",
            "specs/a.py",
            "Testing/run.cs",
            "fixtures/repo/file.txt",
            "src/app.test.ts",
            "src/app.spec.js",
            "pkg/handler_test.go",
            "src/parser_test.rs",
            "scripts/test_parse.py",
            "src/main/java/AppTest.java",
            "Api/UserTests.cs",
            "a/b/test/c/d.txt",
        ] {
            assert!(is_test(path), "{path}");
        }
        for path in [
            "src/lib.rs",
            "src/testing.rs",
            "contest/entry.rs",
            "src/test.rs",
            "latest/file.py",
            "src/attest.py",
            "notes.txt",
            "",
        ] {
            assert!(!is_test(path), "{path}");
        }
    }

    #[test]
    fn large_is_by_lines_or_bytes() {
        assert!(!is_large(5_000, 0, 0));
        assert!(is_large(5_001, 0, 0));
        assert!(!is_large(0, LARGE_BYTES, LARGE_BYTES));
        assert!(is_large(0, LARGE_BYTES + 1, 0));
        assert!(is_large(0, 0, LARGE_BYTES + 1));
    }
}
