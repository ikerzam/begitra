//! The main window, created at start in the background of the theme applied last: the window and
//! its webview paint that colour from their first frame, so nothing shows white before the page
//! does, and the page's start-up screen and then the app paint over the same colour. The frontend
//! hands each theme's background over as it applies it ([`set_window_background`]); it is kept in
//! a file of the app's local data folder for the next start.

use std::path::{Path, PathBuf};

use tauri::window::Color;
use tauri::Manager;

use crate::error::AppError;

/// The window `tauri.conf.json` describes, created here rather than by Tauri (`create: false`).
pub const MAIN_WINDOW: &str = "main";

/// The file of the local data folder that keeps the background, `#rrggbb`.
const BACKGROUND_FILE: &str = "window-background";

/// `#rrggbb` as an opaque colour; anything else is none.
pub fn parse_background(text: &str) -> Option<Color> {
    let hex = text.strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |at: usize| {
        hex.get(at..at + 2)
            .and_then(|pair| u8::from_str_radix(pair, 16).ok())
    };
    Some(Color(channel(0)?, channel(2)?, channel(4)?, 255))
}

/// The background kept in `dir`; none without a file or with anything but a colour in it.
fn stored_background(dir: &Path) -> Option<Color> {
    let text = std::fs::read_to_string(dir.join(BACKGROUND_FILE)).ok()?;
    parse_background(text.trim())
}

/// Keeps `background` in `dir`, which it creates on the first start.
fn keep_background(dir: &Path, background: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(BACKGROUND_FILE), format!("{background}\n"))
}

/// The local data folder, where the background is kept; the caller says what its absence costs.
fn data_dir<M: Manager<tauri::Wry>>(manager: &M) -> Result<PathBuf, tauri::Error> {
    manager.path().app_local_data_dir()
}

/// Creates the main window from its configuration, in the background kept by the last session
/// (the configuration's dark one without it).
pub fn create_main_window(app: &tauri::App) -> tauri::Result<()> {
    let kept = match data_dir(app) {
        Ok(dir) => stored_background(&dir),
        Err(error) => {
            tracing::warn!(%error, "no app data folder: the window starts on the dark background");
            None
        }
    };
    // A configuration that lets Tauri create the window has made it already: it only takes
    // the colour then.
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if let Some(color) = kept {
            window.set_background_color(Some(color))?;
        }
        return Ok(());
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .ok_or(tauri::Error::WindowNotFound)?;
    let mut builder = tauri::WebviewWindowBuilder::from_config(app.handle(), config)?;
    if let Some(color) = kept {
        builder = builder.background_color(color);
    }
    builder.build()?;
    Ok(())
}

/// Keeps `background` (`#rrggbb`, the `--bg-app` of the theme the app applied) for the next start
/// and gives it to the main window now, which shows it where the page has not painted yet.
#[tauri::command]
#[tracing::instrument(level = "debug", skip(app))]
pub async fn set_window_background(
    app: tauri::AppHandle,
    background: String,
) -> Result<(), AppError> {
    let color = parse_background(&background)
        .ok_or_else(|| AppError::invalid_argument("background", "expected #rrggbb"))?;
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if let Err(error) = window.set_background_color(Some(color)) {
            tracing::warn!(%error, "the window keeps its background until the next start");
        }
    }
    let kept = data_dir(&app)
        .map_err(|error| error.to_string())
        .and_then(|dir| keep_background(&dir, &background).map_err(|error| error.to_string()));
    if let Err(error) = kept {
        tracing::warn!(%error, "not kept: the next start uses the background kept before");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_colour_and_nothing_else() {
        assert_eq!(parse_background("#000000"), Some(Color(0, 0, 0, 255)));
        assert_eq!(parse_background("#FDF6E3"), Some(Color(253, 246, 227, 255)));
        for text in [
            "", "#", "#fff", "#1234567", "#12345g", "#+f+f+f", "000000", "red", "#ffffff ",
        ] {
            assert_eq!(parse_background(text), None, "{text:?}");
        }
    }

    #[test]
    fn keeps_the_background_in_a_file_of_its_own() {
        let temp = tempfile::tempdir().expect("temp dir");
        // The folder does not exist before the first start.
        let dir = temp.path().join("dev.begitra.app");
        assert_eq!(stored_background(&dir), None, "nothing kept");
        keep_background(&dir, "#fdf6e3").expect("keep");
        assert_eq!(stored_background(&dir), Some(Color(253, 246, 227, 255)));
        keep_background(&dir, "#000000").expect("keep");
        assert_eq!(stored_background(&dir), Some(Color(0, 0, 0, 255)));
        std::fs::write(dir.join(BACKGROUND_FILE), "url(x)").expect("write");
        assert_eq!(stored_background(&dir), None, "not a colour");
    }
}
