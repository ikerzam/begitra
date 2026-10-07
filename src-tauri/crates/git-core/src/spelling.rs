//! How Begitra spells a folder: the components rebuilt ([`normalise`]), or the file
//! system's own spelling ([`canonical`]). The app stores every folder project's folder and every
//! repository it opens by path canonically, and keys review state by the root it opens, so the
//! app and the agent server, which both resolve a folder here, name a repository alike.

use std::path::{Component, Path, PathBuf, Prefix};

/// Rebuilds a path from its components so spellings compare equal.
pub fn normalise(path: &Path) -> PathBuf {
    path.components().collect()
}

/// Windows' device names: a component named so, with or without an extension, reaches a file
/// only through the verbatim prefix.
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Whether a path without the verbatim prefix still names what the prefix named: shorter than
/// `MAX_PATH`, with no component ending in a dot or a space and none a device name.
fn plain_spelling_holds(plain: &Path) -> bool {
    if plain.to_string_lossy().encode_utf16().count() >= 260 {
        return false;
    }
    plain.components().all(|component| match component {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            let stem = name.split('.').next().unwrap_or_default();
            !name.ends_with('.')
                && !name.ends_with(' ')
                && !RESERVED_NAMES
                    .iter()
                    .any(|reserved| stem.eq_ignore_ascii_case(reserved))
        }
        _ => true,
    })
}

/// `path` without Windows' verbatim prefix (`\\?\C:\…`, `\\?\UNC\server\share\…`),
/// which `canonicalize` adds and nothing else in the app writes, unless the plain spelling
/// would name something else ([`plain_spelling_holds`]); any other path as it is.
pub fn without_verbatim(path: &Path) -> PathBuf {
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return path.to_path_buf();
    };
    let mut plain = match prefix.kind() {
        Prefix::VerbatimDisk(letter) => PathBuf::from(format!("{}:", char::from(letter))),
        Prefix::VerbatimUNC(server, share) => {
            let mut unc = std::ffi::OsString::from(r"\\");
            unc.push(server);
            unc.push(r"\");
            unc.push(share);
            PathBuf::from(unc)
        }
        _ => return path.to_path_buf(),
    };
    for component in components {
        plain.push(component.as_os_str());
    }
    if plain_spelling_holds(&plain) {
        plain
    } else {
        path.to_path_buf()
    }
}

/// `path` as the file system spells it: its case, links, junctions, mapped and substituted
/// drives and `..` resolved, without the verbatim prefix, rebuilt from its components. The
/// app stores every folder project's folder and every repository it opens by path in this
/// spelling, so a folder or repository reached two ways is one entry; a path that cannot be
/// resolved (gone, or a drive that refuses) stays as given. It reads the disk: call it outside
/// the index's lock.
pub fn canonical(path: &Path) -> PathBuf {
    match std::fs::canonicalize(path) {
        Ok(resolved) => normalise(&without_verbatim(&resolved)),
        Err(_) => normalise(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn the_verbatim_prefix_goes_unless_the_plain_spelling_names_something_else() {
        assert_eq!(
            without_verbatim(Path::new(r"\\?\C:\Code\geo portal")),
            PathBuf::from(r"C:\Code\geo portal")
        );
        assert_eq!(
            without_verbatim(Path::new(r"\\?\UNC\nas\share\code")),
            PathBuf::from(r"\\nas\share\code")
        );
        assert_eq!(
            without_verbatim(Path::new(r"C:\Code")),
            PathBuf::from(r"C:\Code")
        );
        // Only the prefix reaches these: a device name, a trailing dot or space, a long path.
        for kept in [
            r"\\?\C:\Code\con",
            r"\\?\C:\Code\aux.txt",
            r"\\?\C:\Code\dots.",
            r"\\?\C:\Code\space ",
        ] {
            assert_eq!(without_verbatim(Path::new(kept)), PathBuf::from(kept));
        }
        let long = format!(r"\\?\C:\{}", "x".repeat(300));
        assert_eq!(without_verbatim(Path::new(&long)), PathBuf::from(&long));
    }
}
