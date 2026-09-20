//! Reading one file whole, at a revision or in the working tree, for the image diff and
//! "Show new file": bounded by [`BLOB_LIMIT`], text or bytes by git's binary heuristic (a
//! NUL in the first 8,000 bytes), the same on both sides.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use git2::{ObjectType, Repository};

use super::Git2Engine;
use crate::engine::GitEngine;
use crate::error::{GitError, GitResult};
use crate::types::{BlobAt, BlobContent};

/// Largest file read whole, in bytes.
pub const BLOB_LIMIT: u64 = 20 * 1024 * 1024;

/// Bytes git inspects for a NUL to call a blob binary.
const BINARY_PROBE: usize = 8_000;

/// Git's heuristic: a NUL in the first 8,000 bytes makes a file binary.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_PROBE).any(|&b| b == 0)
}

/// Reads `path` at `at`; see [`crate::engine::GitEngine::read_blob`].
#[tracing::instrument(level = "debug", skip_all, fields(path))]
pub(super) fn read(engine: &Git2Engine, at: &BlobAt, path: &str) -> GitResult<BlobContent> {
    match at {
        BlobAt::WorkingTree => read_working_tree(&engine.repo().root, path),
        // The bytes come out from under the repository lock; decoding and encoding (a 20 MB
        // image is 27 MB of base64) happen outside it.
        BlobAt::Revision { rev } => engine
            .with_repo(|repo| bytes_at(repo, rev, path))
            .map(content),
    }
}

/// The raw bytes of `path` at `rev`, bounded by [`BLOB_LIMIT`].
fn bytes_at(repo: &Repository, rev: &str, path: &str) -> GitResult<Vec<u8>> {
    let spec = format!("{rev}:{path}");
    let oid = super::resolve_commit(repo, rev)?;
    let commit = repo
        .find_commit(oid)
        .map_err(|error| GitError::object(&oid.to_string(), error))?;
    let tree = commit
        .tree()
        .map_err(|error| GitError::object(&commit.tree_id().to_string(), error))?;
    let entry = tree
        .get_path(Path::new(path))
        .map_err(|_| GitError::RefNotFound(spec.clone()))?;
    if entry.kind() != Some(ObjectType::Blob) {
        return Err(GitError::RefNotFound(spec));
    }
    // The header tells the size without inflating the object, so a huge blob is refused
    // before it is read.
    let (size, _) = repo
        .odb()
        .and_then(|odb| odb.read_header(entry.id()))
        .map_err(|error| GitError::object(&entry.id().to_string(), error))?;
    let size = size as u64;
    if size > BLOB_LIMIT {
        return Err(GitError::BlobTooLarge {
            size,
            limit: BLOB_LIMIT,
        });
    }
    let blob = repo
        .find_blob(entry.id())
        .map_err(|error| GitError::object(&entry.id().to_string(), error))?;
    Ok(blob.content().to_vec())
}

/// Reads the file from disk; the path must stay inside the working tree once resolved, so a
/// symlink that leaves it is refused like an unknown path, and nothing under `.git` is read.
fn read_working_tree(root: &Path, path: &str) -> GitResult<BlobContent> {
    let spec = format!("working tree:{path}");
    let relative = Path::new(path);
    let mut components = relative.components();
    let first = components.next();
    if relative.is_absolute()
        || first.is_none()
        || matches!(first, Some(Component::Normal(name)) if name.eq_ignore_ascii_case(".git"))
        || relative.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::Prefix(_) | Component::RootDir
            )
        })
    {
        return Err(GitError::RefNotFound(spec));
    }
    let full: PathBuf = root.join(relative);
    let resolved = fs::canonicalize(&full).map_err(|_| GitError::RefNotFound(spec.clone()))?;
    let root_resolved = fs::canonicalize(root).map_err(|_| GitError::RefNotFound(spec.clone()))?;
    if !resolved.starts_with(&root_resolved) {
        return Err(GitError::RefNotFound(spec));
    }
    let metadata = fs::metadata(&resolved).map_err(|_| GitError::RefNotFound(spec.clone()))?;
    if !metadata.is_file() {
        return Err(GitError::RefNotFound(spec));
    }
    let size = metadata.len();
    if size > BLOB_LIMIT {
        return Err(GitError::BlobTooLarge {
            size,
            limit: BLOB_LIMIT,
        });
    }
    let bytes = fs::read(&resolved).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => GitError::RefNotFound(spec.clone()),
        _ => GitError::BlobUnreadable {
            path: path.to_owned(),
            reason: error.to_string(),
        },
    })?;
    Ok(content(bytes))
}

/// The content as text (decoded lossily, moved when already valid UTF-8) or as base64 bytes.
fn content(bytes: Vec<u8>) -> BlobContent {
    let size = bytes.len() as u64;
    if looks_binary(&bytes) {
        BlobContent {
            size,
            is_binary: true,
            text: None,
            bytes: Some(base64(&bytes)),
        }
    } else {
        let text = match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(error) => String::from_utf8_lossy(error.as_bytes()).into_owned(),
        };
        BlobContent {
            size,
            is_binary: false,
            text: Some(text),
            bytes: None,
        }
    }
}

/// Standard base64 with padding, without a dependency.
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        let n = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard_alphabet_and_padding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0x00, 0x10]), "/wAQ");
    }

    #[test]
    fn binary_content_carries_bytes_and_text_content_a_string() {
        let text = content(b"hello\n".to_vec());
        assert_eq!(text.text.as_deref(), Some("hello\n"));
        assert!(text.bytes.is_none() && !text.is_binary && text.size == 6);
        let binary = content(vec![0x89, b'P', b'N', b'G', 0]);
        assert!(binary.is_binary && binary.text.is_none());
        assert_eq!(binary.bytes.as_deref(), Some("iVBORwA="));
        // Control characters without a NUL stay text, as for git.
        assert!(!content(vec![1u8; 40]).is_binary);
    }
}
