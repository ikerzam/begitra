//! `begitra-mcp`: an MCP server over stdio that lets an agent read the reviews Begitra keeps
//! (which files the user marked reviewed, the notes on them) and write back: notes of its own,
//! and a note resolved with a reply. It opens the app's index beside the running app (SQLite in
//! write-ahead mode lets both write), and resolves a repository with `git-core` as the app
//! does, so both name a review alike.

#![warn(missing_docs)]
#![forbid(unsafe_code)]

pub mod paths;
pub mod server;
pub mod store;

use rmcp::ServiceExt;

/// Serves MCP on stdin and stdout until the client closes them, over the index `paths`
/// names, with the working folder as the default repository.
pub fn run_stdio() -> Result<(), Box<dyn std::error::Error>> {
    let folder = std::env::current_dir()?;
    let index = paths::index_path()
        .ok_or("no local data folder to find Begitra's index in: set BEGITRA_INDEX to its file")?;
    tracing::info!(index = %index.display(), folder = %folder.display(), "serving");
    let server = server::Server::new(store::Store::new(index), folder);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async move {
        let service = server.serve(rmcp::transport::stdio()).await?;
        service.waiting().await?;
        Ok(())
    })
}
