//! Where Begitra keeps its index: `index.sqlite` in the app's local data folder, where Tauri's
//! `app_local_data_dir()` puts it for the identifier `dev.begitra.app`, unless
//! `BEGITRA_INDEX` names another file (a development server aimed away from the installed
//! app's index).

use std::ffi::OsString;
use std::path::PathBuf;

/// The app's identifier, the name of its data folders.
pub const IDENTIFIER: &str = "dev.begitra.app";

/// The index's file name in the local data folder.
pub const INDEX_FILE: &str = "index.sqlite";

/// The variable that names another index file.
pub const INDEX_ENV: &str = "BEGITRA_INDEX";

/// The index's path; none when the platform names no local data folder (no `LOCALAPPDATA`
/// on Windows, no home elsewhere).
pub fn index_path() -> Option<PathBuf> {
    index_path_from(&|name: &str| std::env::var_os(name))
}

/// [`index_path`] with the environment read through `var`, for tests.
pub fn index_path_from(var: &dyn Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    if let Some(path) = var(INDEX_ENV).filter(|path| !path.is_empty()) {
        return Some(PathBuf::from(path));
    }
    local_data_dir(var).map(|dir| dir.join(IDENTIFIER).join(INDEX_FILE))
}

/// `%LOCALAPPDATA%`, as `dirs::data_local_dir()` reads it for Tauri.
#[cfg(windows)]
fn local_data_dir(var: &dyn Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    absolute(var("LOCALAPPDATA"))
}

/// `~/Library/Application Support`.
#[cfg(target_os = "macos")]
fn local_data_dir(var: &dyn Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    absolute(var("HOME")).map(|home| home.join("Library").join("Application Support"))
}

/// `$XDG_DATA_HOME` when absolute, else `~/.local/share`.
#[cfg(all(unix, not(target_os = "macos")))]
fn local_data_dir(var: &dyn Fn(&str) -> Option<OsString>) -> Option<PathBuf> {
    absolute(var("XDG_DATA_HOME"))
        .or_else(|| absolute(var("HOME")).map(|home| home.join(".local").join("share")))
}

/// `value` as a path when it is an absolute one; a relative or empty value names no folder.
fn absolute(value: Option<OsString>) -> Option<PathBuf> {
    value.map(PathBuf::from).filter(|path| path.is_absolute())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<OsString> + 'a {
        move |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| OsString::from(value))
        }
    }

    #[test]
    fn the_variable_wins_when_set() {
        let path = index_path_from(&env(&[(INDEX_ENV, "/tmp/other.sqlite")]));
        assert_eq!(path, Some(PathBuf::from("/tmp/other.sqlite")));
    }

    #[cfg(windows)]
    #[test]
    fn local_app_data_on_windows() {
        let path = index_path_from(&env(&[("LOCALAPPDATA", r"C:\Users\ana\AppData\Local")]));
        assert_eq!(
            path,
            Some(PathBuf::from(
                r"C:\Users\ana\AppData\Local\dev.begitra.app\index.sqlite"
            ))
        );
        assert_eq!(index_path_from(&env(&[])), None);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn xdg_data_home_then_the_home_on_linux() {
        let path = index_path_from(&env(&[("XDG_DATA_HOME", "/data"), ("HOME", "/home/ana")]));
        assert_eq!(
            path,
            Some(PathBuf::from("/data/dev.begitra.app/index.sqlite"))
        );
        let path = index_path_from(&env(&[
            ("XDG_DATA_HOME", "relative"),
            ("HOME", "/home/ana"),
        ]));
        assert_eq!(
            path,
            Some(PathBuf::from(
                "/home/ana/.local/share/dev.begitra.app/index.sqlite"
            ))
        );
    }
}
