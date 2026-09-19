//! Begira desktop application: the Tauri layer that exposes `git-core` to the Vue frontend
//! through typed commands, streamed Channels, cancellable operations and one `AppError`.

/// Builds and runs the Tauri application.
///
/// Exits the process with status 1 if the runtime fails to start; there is no UI to report to
/// at that point.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!());

    if let Err(error) = result {
        eprintln!("begira: failed to start the application runtime: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    /// The engine crates must stay usable from a CLI or an agent, so they never depend on Tauri.
    #[test]
    fn engine_crates_do_not_depend_on_tauri() {
        let manifests = [
            ("git-core", include_str!("../crates/git-core/Cargo.toml")),
            (
                "repo-index",
                include_str!("../crates/repo-index/Cargo.toml"),
            ),
        ];
        for (name, manifest) in manifests {
            let offending: Vec<&str> = manifest
                .lines()
                .map(str::trim)
                .filter(|line| line.starts_with("tauri"))
                .collect();
            assert!(
                offending.is_empty(),
                "{name} depends on tauri: {offending:?}"
            );
        }
    }
}
