//! `begira-cli`: the engine's read operations as JSON on stdout (see the library).

use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let stdout = std::io::stdout();
    let stderr = std::io::stderr();
    let status = begira_cli::main_with(&args, &mut stdout.lock(), &mut stderr.lock());
    let _ = stdout.lock().flush();
    std::process::exit(status);
}
