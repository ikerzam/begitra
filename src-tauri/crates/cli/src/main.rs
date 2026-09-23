//! `begitra-cli`: the engine's read operations as JSON on stdout (see the library).

use std::io::{BufWriter, Write};

fn main() {
    // An argument that is not UTF-8 is a usage error, not a panic.
    let args: Result<Vec<String>, std::ffi::OsString> = std::env::args_os()
        .skip(1)
        .map(std::ffi::OsString::into_string)
        .collect();
    let stdout = std::io::stdout();
    let stderr = std::io::stderr();
    // 64 KiB between serde's small writes and the pipe; every NDJSON line is flushed whole.
    let mut out = BufWriter::with_capacity(64 * 1024, stdout.lock());
    let status = match args {
        Ok(args) => begitra_cli::main_with(&args, &mut out, &mut stderr.lock()),
        Err(_) => begitra_cli::usage_error("an argument is not valid UTF-8", &mut stderr.lock()),
    };
    let _ = out.flush();
    std::process::exit(status);
}
