//! A conflicted file's conflict blocks: read from the working tree with git's marker rules, and
//! rewritten one block at a time, only while the file is the one read.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use git2::{AttrCheckFlags, AttrValue, ErrorCode, ObjectType, Oid};

use super::blob::{base64, base64_decode};
use super::sides::{self, Stage};
use super::Git2Engine;
use crate::engine::{Cancel, GitEngine};
use crate::error::{GitError, GitResult};
use crate::types::{
    BlockResolution, BlockResolved, BlockSide, BlockUndo, ConflictBlock, ConflictText, Side,
    CONFLICT_FILE_MAX_BYTES,
};

/// Git's marker size without a `conflict-marker-size` attribute.
const DEFAULT_MARKER_SIZE: usize = 7;

/// How far git looks for a NUL to call a file binary (`buffer_is_binary`): git writes no
/// markers into one.
const BINARY_PROBE: usize = 8000;

/// How many other marker sizes a file without blocks at its attribute's size is read at.
const SIZES_TRIED: usize = 4;

/// A conflicted file as read: where it is, its bytes, its `conflict-marker-size` and the
/// versions git merged it from.
struct Read {
    file: PathBuf,
    bytes: Vec<u8>,
    marker_size: usize,
    versions: Versions,
}

/// See [`GitEngine::conflict_blocks`].
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn conflict_blocks(
    engine: &Git2Engine,
    path: &str,
    cancel: &Cancel,
) -> GitResult<ConflictText> {
    let read = read(engine, path, cancel)?;
    let parsed = blocks(&read.bytes, read.marker_size, &read.versions)?;
    // A NUL near the start of a file that pairs no marker: not text git's line merge wrote (a
    // `working-tree-encoding` writes git's markers in that encoding).
    if parsed.text.blocks.is_empty() && early_nul(&read.bytes) {
        return Err(GitError::ConflictUnreadable(path.to_owned()));
    }
    Ok(parsed.text)
}

/// See [`GitEngine::resolve_conflict_block`].
#[tracing::instrument(level = "debug", skip_all, fields(block = block))]
pub(super) fn resolve_conflict_block(
    engine: &Git2Engine,
    path: &str,
    fingerprint: &str,
    block: usize,
    resolution: &BlockResolution,
    cancel: &Cancel,
) -> GitResult<BlockResolved> {
    let read = read(engine, path, cancel)?;
    let parsed = blocks(&read.bytes, read.marker_size, &read.versions)?;
    if parsed.text.fingerprint != fingerprint {
        return Err(GitError::ConflictFileChanged(path.to_owned()));
    }
    // A block the reading had and this one has not: the reading is stale.
    let Some(found) = parsed.text.blocks.get(block).cloned() else {
        return Err(GitError::ConflictFileChanged(path.to_owned()));
    };
    if matches!(resolution, BlockResolution::Text { .. }) && !parsed.text.utf8 {
        return Err(GitError::Git(format!(
            "{path} is not UTF-8: a text written into it would change its bytes"
        )));
    }
    let offsets = &parsed.offsets;
    let range = |start: u32, end: u32| &read.bytes[offsets[start as usize]..offsets[end as usize]];
    let mut replacement = match resolution {
        BlockResolution::Ours => range(found.ours.start, found.ours.end).to_vec(),
        BlockResolution::Theirs => range(found.theirs.start, found.theirs.end).to_vec(),
        BlockResolution::Both => {
            let ours = range(found.ours.start, found.ours.end);
            let theirs = range(found.theirs.start, found.theirs.end);
            let mut both = Vec::with_capacity(ours.len() + theirs.len());
            both.extend_from_slice(ours);
            both.extend_from_slice(theirs);
            both
        }
        BlockResolution::Text { text } => text_bytes(text, parsed.text.crlf),
    };
    let start = offsets[found.start as usize];
    let end = offsets[found.end as usize];
    let block_bytes = &read.bytes[start..end];
    if end == read.bytes.len() {
        // At the file's end the side's own file says whether its last line ends, as `git
        // checkout --ours` or `--theirs` writes it: git ends every side and marker with one.
        // A marker edited without its line ending leaves the replacement without one too.
        let last_side = match resolution {
            BlockResolution::Ours => Some(&read.versions.ours),
            BlockResolution::Theirs | BlockResolution::Both => Some(&read.versions.theirs),
            BlockResolution::Text { .. } => None,
        };
        let side_ends = last_side.is_none_or(|side| side.bytes.last() == Some(&b'\n'));
        if !side_ends || !block_bytes.ends_with(b"\n") {
            trim_line_ending(&mut replacement);
        }
    }
    let written = spliced(&read.bytes, start, end, &replacement);
    if written.len() as u64 > CONFLICT_FILE_MAX_BYTES {
        return Err(GitError::ConflictWriteFailed {
            path: path.to_owned(),
            reason: "the file would be larger than the 4 MiB its blocks are read for".to_owned(),
        });
    }
    let replaced = base64(block_bytes);
    drop(parsed);
    // A cancel or a timeout that came while the file was read writes nothing.
    cancel.check()?;
    write(&read, path, &written)?;
    let file = blocks(&written, read.marker_size, &read.versions)?.text;
    let undo = BlockUndo {
        fingerprint: file.fingerprint.clone(),
        start: found.start,
        lines: line_count(&replacement),
        bytes: replaced,
    };
    Ok(BlockResolved { file, undo })
}

/// See [`GitEngine::undo_conflict_block`].
#[tracing::instrument(level = "debug", skip_all)]
pub(super) fn undo_conflict_block(
    engine: &Git2Engine,
    path: &str,
    undo: &BlockUndo,
    cancel: &Cancel,
) -> GitResult<ConflictText> {
    let read = read(engine, path, cancel)?;
    if blob_id(&read.bytes)? != undo.fingerprint {
        return Err(GitError::ConflictFileChanged(path.to_owned()));
    }
    let Some(bytes) = base64_decode(&undo.bytes) else {
        return Err(GitError::Git(format!(
            "the block to put back into {path} is not base64"
        )));
    };
    let offsets = line_offsets(&read.bytes);
    let lines = offsets.len() - 1;
    let first = undo.start as usize;
    let Some(after) = first
        .checked_add(undo.lines as usize)
        .filter(|after| *after <= lines)
    else {
        return Err(GitError::ConflictFileChanged(path.to_owned()));
    };
    let written = spliced(&read.bytes, offsets[first], offsets[after], &bytes);
    cancel.check()?;
    write(&read, path, &written)?;
    Ok(blocks(&written, read.marker_size, &read.versions)?.text)
}

/// The file of a conflicted `path`, its marker size and the versions git merged it from. A
/// path git does not list as conflicted is refused, which keeps every path inside the working
/// tree. Git writes markers only where both sides have the file as a regular file, only into
/// text and only when one of its own line merges merges it, so a side that deleted it, a link, a
/// submodule, a binary file (a NUL in the first 8000 bytes of one of the three versions, as git
/// tells), a file the attributes merge otherwise (`-merge`, `merge=binary`, the `binary` macro, a
/// driver of the user's, whose output is its own), a file under a folder that leads out of the
/// working tree, a file over [`CONFLICT_FILE_MAX_BYTES`] and a version over twice that are not
/// read: the whole-file choices answer them.
fn read(engine: &Git2Engine, path: &str, cancel: &Cancel) -> GitResult<Read> {
    cancel.check()?;
    let unreadable = || GitError::ConflictUnreadable(path.to_owned());
    let unmerged = sides::unmerged(engine, cancel)?;
    let Some(entry) = unmerged.get(path) else {
        return Err(GitError::NotConflicted(path.to_owned()));
    };
    let (Some(ours), Some(theirs)) = (entry.stage(Side::Ours), entry.stage(Side::Theirs)) else {
        return Err(unreadable());
    };
    let (Some(ours), Some(theirs)) = (regular_blob(ours), regular_blob(theirs)) else {
        return Err(unreadable());
    };
    // A base that is no regular file (a link both sides replaced) gives the line merge none.
    let base = entry.base().and_then(regular_blob);
    let file = inside(&GitEngine::repo(engine).root, path).ok_or_else(unreadable)?;
    let readable = fs::symlink_metadata(&file)
        .is_ok_and(|meta| meta.file_type().is_file() && meta.len() <= CONFLICT_FILE_MAX_BYTES);
    if !readable {
        return Err(unreadable());
    }
    // The versions and the attributes before the bytes: what runs between the read and the
    // write stays short.
    let (attribute_size, by_lines, texts) = engine.with_repo(|repo| {
        let text = |blob: Oid| {
            repo.find_blob(blob)
                .ok()
                .filter(|found| found.size() as u64 <= 2 * CONFLICT_FILE_MAX_BYTES)
                .map(|found| found.content().to_vec())
        };
        let texts = (base.map(text), text(ours), text(theirs));
        Ok((marker_size(repo, path), merged_by_lines(repo, path), texts))
    })?;
    if !by_lines {
        return Err(unreadable());
    }
    let (base, Some(ours), Some(theirs)) = texts else {
        return Err(unreadable());
    };
    let base = match base {
        Some(Some(text)) => Some(Version::new(text)),
        Some(None) => return Err(unreadable()),
        None => None,
    };
    let versions = Versions {
        base,
        ours: Version::new(ours),
        theirs: Version::new(theirs),
    };
    if versions.all().any(|version| early_nul(&version.bytes)) {
        return Err(unreadable());
    }
    let bytes = fs::read(&file).map_err(|error| GitError::BlobUnreadable {
        path: path.to_owned(),
        reason: error.to_string(),
    })?;
    if bytes.len() as u64 > CONFLICT_FILE_MAX_BYTES {
        return Err(unreadable());
    }
    Ok(Read {
        file,
        bytes,
        marker_size: attribute_size,
        versions,
    })
}

/// A NUL in the first 8000 bytes, git's sign of a binary file (`buffer_is_binary`).
fn early_nul(bytes: &[u8]) -> bool {
    bytes[..bytes.len().min(BINARY_PROBE)].contains(&0)
}

/// A stage's blob when it is a regular file, executable or not.
fn regular_blob(stage: &Stage) -> Option<Oid> {
    if stage.mode != "100644" && stage.mode != "100755" {
        return None;
    }
    Oid::from_str(&stage.hash).ok()
}

/// `path` under `root` with its folders resolved, while they stay inside the working tree: a
/// folder that is a link or a junction to elsewhere is not followed.
fn inside(root: &Path, path: &str) -> Option<PathBuf> {
    let file = root.join(path);
    let name = file.file_name()?.to_owned();
    let folder = fs::canonicalize(file.parent()?).ok()?;
    let root = fs::canonicalize(root).ok()?;
    if !folder.starts_with(&root) {
        return None;
    }
    Some(folder.join(name))
}

/// Writes `bytes` in place of the file `read` read: through a new file beside it, whose mode
/// is the file's, renamed over it once the file still holds the bytes read. A failed write
/// leaves the file as it was, never half written; a file saved elsewhere meanwhile is kept and
/// the answer is [`GitError::ConflictFileChanged`].
fn write(read: &Read, path: &str, bytes: &[u8]) -> GitResult<()> {
    let failed = |error: io::Error| GitError::ConflictWriteFailed {
        path: path.to_owned(),
        reason: error.to_string(),
    };
    let (temporary, handle) = temporary_beside(&read.file).map_err(failed)?;
    let swapped = swap(&temporary, handle, read, bytes);
    match swapped {
        Ok(true) => Ok(()),
        Ok(false) => {
            let _ = fs::remove_file(&temporary);
            Err(GitError::ConflictFileChanged(path.to_owned()))
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            Err(failed(error))
        }
    }
}

/// [`write`]'s steps; false when the file changed since it was read.
fn swap(temporary: &Path, mut handle: fs::File, read: &Read, bytes: &[u8]) -> io::Result<bool> {
    handle.write_all(bytes)?;
    handle.sync_all()?;
    drop(handle);
    fs::set_permissions(temporary, fs::metadata(&read.file)?.permissions())?;
    // The last look before the rename: an editor's save since the read wins.
    if fs::read(&read.file)? != read.bytes {
        return Ok(false);
    }
    fs::rename(temporary, &read.file)?;
    Ok(true)
}

/// A new file beside `file` for [`write`]: `.<name>.begitra-block`, then numbered while the
/// name is taken.
fn temporary_beside(file: &Path) -> io::Result<(PathBuf, fs::File)> {
    let (Some(folder), Some(name)) = (file.parent(), file.file_name()) else {
        return Err(io::Error::other("the path has no file name"));
    };
    let name = name.to_string_lossy();
    for attempt in 0..16 {
        let candidate = if attempt == 0 {
            folder.join(format!(".{name}.begitra-block"))
        } else {
            folder.join(format!(".{name}.begitra-block-{attempt}"))
        };
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(handle) => return Ok((candidate, handle)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::other(
        "no free name beside the file for the write",
    ))
}

/// The `conflict-marker-size` attribute of `path`; [`DEFAULT_MARKER_SIZE`] without one, or
/// with one [`size_value`] does not take.
fn marker_size(repo: &git2::Repository, path: &str) -> usize {
    repo.get_attr(
        Path::new(path),
        "conflict-marker-size",
        AttrCheckFlags::FILE_THEN_INDEX,
    )
    .ok()
    .flatten()
    .and_then(size_value)
    .unwrap_or(DEFAULT_MARKER_SIZE)
}

/// A `conflict-marker-size` value as git 2.48 and later read it for the markers they write
/// (`strtol_i`): a whole `int` after the white space `strtol` skips, a sign allowed, and above 0.
fn size_value(value: &str) -> Option<usize> {
    let digits = value.trim_start_matches([' ', '\t', '\n', '\x0b', '\x0c', '\r']);
    let size = digits.parse::<i32>().ok()?;
    usize::try_from(size).ok().filter(|size| *size > 0)
}

/// Whether git merges `path` with one of its own line merges (text, or union, which leaves no
/// conflict), as git picks the driver (`find_ll_merge_driver`): the `merge` attribute names it,
/// `merge.default` names it when the attribute is unspecified, a driver of the user's (any
/// `merge.<name>.<key>`) comes before git's own, and a name without a driver merges as text.
/// Not by git's lines: `-merge`, `merge=binary`, the `binary` macro, and a driver of the user's,
/// whose output is its own. An attribute or a configuration that cannot be read says no.
fn merged_by_lines(repo: &git2::Repository, path: &str) -> bool {
    let Ok(value) = repo.get_attr(Path::new(path), "merge", AttrCheckFlags::FILE_THEN_INDEX) else {
        return false;
    };
    let Ok(config) = repo.config() else {
        return false;
    };
    let driver = match AttrValue::from_string(value) {
        AttrValue::True => return true,
        AttrValue::False | AttrValue::Bytes(_) => return false,
        AttrValue::String(name) => name.to_owned(),
        AttrValue::Unspecified => match config.get_string("merge.default") {
            Ok(name) => name,
            Err(error) if error.code() == ErrorCode::NotFound => return true,
            Err(_) => return false,
        },
    };
    user_driver(&config, &driver) == Some(false) && driver != "binary"
}

/// Whether the configuration holds a merge driver named `name`, as git makes one of any
/// `merge.<name>.<key>`; `None` when the configuration cannot be read.
fn user_driver(config: &git2::Config, name: &str) -> Option<bool> {
    let mut entries = config.entries(Some(r"^merge\..+\.")).ok()?;
    while let Some(entry) = entries.next() {
        let named = entry
            .ok()?
            .name()
            .ok()
            .and_then(|key| key.strip_prefix("merge."))
            .and_then(|rest| rest.rsplit_once('.'))
            .is_some_and(|(driver, _)| driver == name);
        if named {
            return Some(true);
        }
    }
    Some(false)
}

/// The file read at the marker size its blocks pair at: the attribute's `size`, or, when no
/// block of git's pairs at it, the length of a run of three or more `<` that starts a line before
/// a space (the first few such lengths, in their order) at which blocks of git's pair. Git takes
/// the attribute from the working tree before the operation, which the merge may change, and a
/// `resolve` or an octopus merge does not read it at all; `git checkout -m` and rerere read the
/// attribute after it. Which blocks are git's: [`git_blocks`].
fn blocks(bytes: &[u8], size: usize, versions: &Versions) -> GitResult<Parsed> {
    let mut parsed = scan(bytes)?;
    let pairing = |size: usize| {
        let (found, paired) = pair(bytes, &parsed.offsets, size, versions);
        git_blocks(found, paired, bytes, &parsed.offsets, versions)
    };
    let (mut found, mut paired) = pairing(size);
    if found.is_empty() {
        let mut tried = [size; SIZES_TRIED + 1];
        let mut count = 1;
        for line in parsed.offsets.windows(2).map(|at| &bytes[at[0]..at[1]]) {
            let run = line.iter().take_while(|byte| **byte == b'<').count();
            if run < 3 || line.get(run) != Some(&b' ') || tried[..count].contains(&run) {
                continue;
            }
            tried[count] = run;
            count += 1;
            let (other, other_paired) = pairing(run);
            if !other.is_empty() {
                tracing::debug!(attribute = size, size = run, "markers read at another size");
                (found, paired) = (other, other_paired);
                break;
            }
            if count > SIZES_TRIED {
                break;
            }
        }
    }
    parsed.text.blocks = found;
    parsed.text.paired = paired;
    Ok(parsed)
}

/// The blocks git wrote among those that pair: a block whose lines, its markers included, follow
/// one another in a version git merged is the file's own text (an example of git's markers in a
/// page, markers committed by mistake, the inner block of a virtual merge base, which the base
/// version holds), not one of this merge's. Git writes every block of a file in one style, with a
/// base or without, so the blocks left that mix them hold a `|||||||` line in a side and leave
/// the file unpaired, with no block.
fn git_blocks(
    mut blocks: Vec<ConflictBlock>,
    paired: bool,
    bytes: &[u8],
    offsets: &[usize],
    versions: &Versions,
) -> (Vec<ConflictBlock>, bool) {
    if !paired {
        return (Vec::new(), false);
    }
    let line = |at: usize| content(&bytes[offsets[at]..offsets[at + 1]]);
    blocks.retain(|block| {
        let (start, end) = (block.start as usize, block.end as usize);
        !versions
            .all()
            .any(|version| version.holds((start..end).map(line)))
    });
    let with_base = blocks.iter().filter(|block| block.base.is_some()).count();
    if with_base != 0 && with_base != blocks.len() {
        return (Vec::new(), false);
    }
    (blocks, true)
}

/// One version of the file git merged (its blob in stage 1, 2 or 3): its bytes, where its lines
/// start, and its lines that begin with three or more `<` or `>`, by their text without the line
/// ending, with where they are. Git's markers of this merge are in no version, so a marker line a
/// version holds is the file's own text.
struct Version {
    bytes: Vec<u8>,
    offsets: Vec<usize>,
    markers: HashMap<Vec<u8>, Vec<usize>>,
}

impl Version {
    fn new(bytes: Vec<u8>) -> Self {
        let offsets = line_offsets(&bytes);
        let mut markers: HashMap<Vec<u8>, Vec<usize>> = HashMap::new();
        for (at, range) in offsets.windows(2).enumerate() {
            let line = content(&bytes[range[0]..range[1]]);
            if line.starts_with(b"<<<") || line.starts_with(b">>>") {
                markers.entry(line.to_vec()).or_default().push(at);
            }
        }
        Self {
            bytes,
            offsets,
            markers,
        }
    }

    fn line(&self, at: usize) -> Option<&[u8]> {
        let start = *self.offsets.get(at)?;
        let end = *self.offsets.get(at + 1)?;
        Some(content(&self.bytes[start..end]))
    }

    /// Whether this version holds `lines` one after another, the first one a marker line.
    fn holds<'b>(&self, mut lines: impl Iterator<Item = &'b [u8]> + Clone) -> bool {
        let Some(first) = lines.next() else {
            return false;
        };
        self.markers.get(first).is_some_and(|starts| {
            starts.iter().any(|start| {
                lines
                    .clone()
                    .enumerate()
                    .all(|(offset, line)| self.line(start + 1 + offset) == Some(line))
            })
        })
    }

    fn holds_line(&self, line: &[u8]) -> bool {
        self.markers.contains_key(line)
    }
}

/// The versions git merged the file from: the base (none for a file both sides added) and the
/// two sides.
struct Versions {
    base: Option<Version>,
    ours: Version,
    theirs: Version,
}

impl Versions {
    fn all(&self) -> impl Iterator<Item = &Version> {
        self.base.iter().chain([&self.ours, &self.theirs])
    }

    /// Versions given as their texts.
    #[cfg(test)]
    fn of(base: Option<&[u8]>, ours: &[u8], theirs: &[u8]) -> Self {
        Self {
            base: base.map(|text| Version::new(text.to_vec())),
            ours: Version::new(ours.to_vec()),
            theirs: Version::new(theirs.to_vec()),
        }
    }
}

fn blob_id(bytes: &[u8]) -> GitResult<String> {
    Ok(Oid::hash_object(ObjectType::Blob, bytes)?.to_string())
}

/// A file read: its text, and where each line starts in its bytes (the last entry is the
/// file's length).
struct Parsed {
    text: ConflictText,
    offsets: Vec<usize>,
}

/// The start of each line in `bytes`, then the length: lines end at `\n`, and a last line
/// without one still counts.
fn line_offsets(bytes: &[u8]) -> Vec<usize> {
    let mut offsets = vec![0];
    for (at, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            offsets.push(at + 1);
        }
    }
    if offsets.last() != Some(&bytes.len()) {
        offsets.push(bytes.len());
    }
    offsets
}

/// A line without its `\n` and a `\r` before it.
fn content(raw: &[u8]) -> &[u8] {
    let line = raw.strip_suffix(b"\n").unwrap_or(raw);
    trim_cr(line)
}

fn trim_cr(line: &[u8]) -> &[u8] {
    line.strip_suffix(b"\r").unwrap_or(line)
}

/// One of git's markers: the label after it when `line` (without its line ending) is
/// `marker` repeated `size` times, then a space for `<` and `>`, and white space or nothing for
/// `|` and `=`, as git's rerere reads them; a longer run is no marker of this size.
fn marker(line: &[u8], marker: u8, size: usize) -> Option<String> {
    if line.len() < size || line[..size].iter().any(|byte| *byte != marker) {
        return None;
    }
    let rest = &line[size..];
    let wants_space = marker == b'<' || marker == b'>';
    match rest.first() {
        None if !wants_space => Some(String::new()),
        Some(b' ') => Some(String::from_utf8_lossy(&rest[1..]).trim().to_owned()),
        Some(b'\t' | b'\r') if !wants_space => {
            Some(String::from_utf8_lossy(rest).trim().to_owned())
        }
        _ => None,
    }
}

/// Where the reading of a block stands.
enum Reading {
    Outside,
    Ours {
        start: usize,
        label: String,
    },
    Base {
        start: usize,
        ours: BlockSide,
        label: String,
        from: usize,
    },
    Theirs {
        start: usize,
        ours: BlockSide,
        base: Option<BlockSide>,
        from: usize,
    },
}

fn side(label: String, start: usize, end: usize) -> BlockSide {
    BlockSide {
        label,
        start: index(start),
        end: index(end),
    }
}

fn index(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// The file's lines, its line ending, its fingerprint and whether it is UTF-8: what reads the
/// same at every marker size. Its blocks are [`pair`]'s.
fn scan(bytes: &[u8]) -> GitResult<Parsed> {
    let offsets = line_offsets(bytes);
    let mut lines = Vec::with_capacity(offsets.len());
    let (mut crlf, mut lf) = (0usize, 0usize);
    for at in offsets.windows(2) {
        let raw = &bytes[at[0]..at[1]];
        if raw.ends_with(b"\r\n") {
            crlf += 1;
        } else if raw.ends_with(b"\n") {
            lf += 1;
        }
        lines.push(String::from_utf8_lossy(content(raw)).into_owned());
    }
    Ok(Parsed {
        text: ConflictText {
            fingerprint: blob_id(bytes)?,
            utf8: std::str::from_utf8(bytes).is_ok(),
            crlf: crlf > lf,
            paired: true,
            lines,
            blocks: Vec::new(),
        },
        offsets,
    })
}

/// The blocks of `bytes` at `size`, and whether its markers pair. Outside a block `<<<<<<<`
/// opens one, `|||||||` and `=======` are text as git's rerere reads them, and `>>>>>>>`, which
/// git never writes there, is text when a side holds that very line and otherwise leaves the
/// file unpaired (an incoming side that holds such a line closed its block early); inside a
/// block the markers must come in their order, and a marker out of it, or a block the file ends
/// inside, leaves the file unpaired too. An unpaired file has no block.
fn pair(
    bytes: &[u8],
    offsets: &[usize],
    size: usize,
    versions: &Versions,
) -> (Vec<ConflictBlock>, bool) {
    let mut blocks = Vec::new();
    let mut reading = Reading::Outside;
    let mut paired = true;
    for (at, range) in offsets.windows(2).enumerate() {
        if !paired {
            break;
        }
        let content = content(&bytes[range[0]..range[1]]);
        reading = match reading {
            Reading::Outside => {
                if let Some(label) = marker(content, b'<', size) {
                    Reading::Ours { start: at, label }
                } else {
                    let side_text =
                        versions.ours.holds_line(content) || versions.theirs.holds_line(content);
                    if marker(content, b'>', size).is_some() && !side_text {
                        paired = false;
                    }
                    Reading::Outside
                }
            }
            Reading::Ours { start, label } => {
                if let Some(base) = marker(content, b'|', size) {
                    Reading::Base {
                        start,
                        ours: side(label, start + 1, at),
                        label: base,
                        from: at + 1,
                    }
                } else if marker(content, b'=', size).is_some() {
                    Reading::Theirs {
                        start,
                        ours: side(label, start + 1, at),
                        base: None,
                        from: at + 1,
                    }
                } else if marker(content, b'<', size).is_some()
                    || marker(content, b'>', size).is_some()
                {
                    paired = false;
                    Reading::Outside
                } else {
                    Reading::Ours { start, label }
                }
            }
            Reading::Base {
                start,
                ours,
                label,
                from,
            } => {
                if marker(content, b'=', size).is_some() {
                    Reading::Theirs {
                        start,
                        ours,
                        base: Some(side(label, from, at)),
                        from: at + 1,
                    }
                } else if marker(content, b'<', size).is_some()
                    || marker(content, b'|', size).is_some()
                    || marker(content, b'>', size).is_some()
                {
                    paired = false;
                    Reading::Outside
                } else {
                    Reading::Base {
                        start,
                        ours,
                        label,
                        from,
                    }
                }
            }
            Reading::Theirs {
                start,
                ours,
                base,
                from,
            } => {
                if let Some(label) = marker(content, b'>', size) {
                    blocks.push(ConflictBlock {
                        start: index(start),
                        end: index(at + 1),
                        ours,
                        base,
                        theirs: side(label, from, at),
                    });
                    Reading::Outside
                } else if marker(content, b'<', size).is_some()
                    || marker(content, b'|', size).is_some()
                    || marker(content, b'=', size).is_some()
                {
                    paired = false;
                    Reading::Outside
                } else {
                    Reading::Theirs {
                        start,
                        ours,
                        base,
                        from,
                    }
                }
            }
        };
    }
    if !matches!(reading, Reading::Outside) {
        paired = false;
    }
    if !paired {
        blocks.clear();
    }
    (blocks, paired)
}

/// `text` as the lines of a block: split on `\n` (a `\r` before it dropped), each written with
/// the file's line ending; a newline at its end adds no empty line, and an empty text none.
fn text_bytes(text: &str, crlf: bool) -> Vec<u8> {
    let ending: &[u8] = if crlf { b"\r\n" } else { b"\n" };
    if text.is_empty() {
        return Vec::new();
    }
    let body = text.strip_suffix('\n').unwrap_or(text);
    let mut out = Vec::with_capacity(text.len() + 16);
    for line in body.split('\n') {
        out.extend_from_slice(line.strip_suffix('\r').unwrap_or(line).as_bytes());
        out.extend_from_slice(ending);
    }
    out
}

fn trim_line_ending(bytes: &mut Vec<u8>) {
    if bytes.ends_with(b"\r\n") {
        bytes.truncate(bytes.len() - 2);
    } else if bytes.ends_with(b"\n") {
        bytes.truncate(bytes.len() - 1);
    }
}

/// The lines `bytes` holds, a last one without a line ending included.
fn line_count(bytes: &[u8]) -> u32 {
    let endings = bytes.iter().filter(|byte| **byte == b'\n').count();
    let open = usize::from(!bytes.is_empty() && !bytes.ends_with(b"\n"));
    index(endings + open)
}

fn spliced(bytes: &[u8], start: usize, end: usize, middle: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() - (end - start) + middle.len());
    out.extend_from_slice(&bytes[..start]);
    out.extend_from_slice(middle);
    out.extend_from_slice(&bytes[end..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markers_follow_gits_rules() {
        assert_eq!(marker(b"<<<<<<< HEAD", b'<', 7).as_deref(), Some("HEAD"));
        assert_eq!(marker(b"<<<<<<<", b'<', 7), None);
        assert_eq!(marker(b"<<<<<<<< x", b'<', 7), None);
        assert_eq!(marker(b"=======", b'=', 7).as_deref(), Some(""));
        assert_eq!(marker(b"=======  ", b'=', 7).as_deref(), Some(""));
        assert_eq!(marker(b"=======\r", b'=', 7).as_deref(), Some(""));
        assert_eq!(marker(b"=======\x0c", b'=', 7), None);
        assert_eq!(marker(b"=======\x0b", b'=', 7), None);
        assert_eq!(marker(b"========", b'=', 7), None);
        assert_eq!(marker(b"||||||| base", b'|', 7).as_deref(), Some("base"));
        assert_eq!(
            marker(b">>>>>>> feature", b'>', 7).as_deref(),
            Some("feature")
        );
        assert_eq!(
            marker(b"<<<<<<<<<< HEAD", b'<', 10).as_deref(),
            Some("HEAD")
        );
    }

    #[test]
    fn a_text_takes_the_files_line_ending() {
        assert_eq!(text_bytes("a\nb\n", true), b"a\r\nb\r\n");
        assert_eq!(text_bytes("a\r\nb", false), b"a\nb\n");
        assert_eq!(text_bytes("", false), b"");
        assert_eq!(text_bytes("\n", false), b"\n");
    }

    #[test]
    fn lines_are_counted_with_a_last_open_one() {
        assert_eq!(line_count(b""), 0);
        assert_eq!(line_count(b"a\n"), 1);
        assert_eq!(line_count(b"a\nb"), 2);
        assert_eq!(line_offsets(b"a\nb"), vec![0, 2, 3]);
        assert_eq!(line_offsets(b"a\n"), vec![0, 2]);
        assert_eq!(line_offsets(b""), vec![0]);
    }

    #[test]
    fn markers_out_of_order_leave_the_file_unpaired() {
        let none = Versions::of(None, b"", b"");
        let read = |bytes: &[u8]| {
            let offsets = line_offsets(bytes);
            let (found, paired) = pair(bytes, &offsets, 7, &none);
            git_blocks(found, paired, bytes, &offsets, &none)
        };
        assert_eq!(read(b"a\n<<<<<<< x\nb\n>>>>>>> y\n"), (Vec::new(), false));
        assert_eq!(read(b"=======\n||||||| y\ntext\n"), (Vec::new(), true));
        assert_eq!(read(b"text\n>>>>>>> y\n"), (Vec::new(), false));
        // One block with a base and one without: a side held a `|||||||` line.
        let mixed = b"<<<<<<< a\nx\n||||||| b\ny\n=======\nz\n>>>>>>> c\n<<<<<<< a\nx\n=======\nz\n>>>>>>> c\n";
        assert_eq!(read(mixed), (Vec::new(), false));
        let both = b"<<<<<<< a\nx\n||||||| b\ny\n=======\nz\n>>>>>>> c\n<<<<<<< a\nx\n||||||| b\n=======\nz\n>>>>>>> c\n";
        let (blocks, paired) = read(both);
        assert!(paired);
        assert_eq!(blocks.len(), 2);
    }

    #[test]
    fn a_closing_marker_a_side_holds_is_text() {
        let file = b">>>>>>> quoted\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> feature\n";
        let offsets = line_offsets(file);
        let quoted = Versions::of(None, b">>>>>>> quoted\nx\n", b">>>>>>> quoted\ny\n");
        let (found, paired) = pair(file, &offsets, 7, &quoted);
        assert!(paired);
        assert_eq!(found.len(), 1);
        let bare = Versions::of(None, b"x\n", b"y\n");
        assert_eq!(pair(file, &offsets, 7, &bare), (Vec::new(), false));
    }

    #[test]
    fn marker_sizes_read_as_git_reads_them() {
        for (value, size) in [
            ("12", Some(12)),
            ("+9", Some(9)),
            (" 8", Some(8)),
            ("10abc", None),
            ("9.5", None),
            ("-3", None),
            ("0", None),
            ("", None),
            ("99999999999", None),
        ] {
            assert_eq!(size_value(value), size, "{value:?}");
        }
    }

    #[test]
    fn blocks_pair_at_the_size_the_file_holds() {
        let none = Versions::of(None, b"", b"");
        let nine = b"a\n<<<<<<<<< HEAD\nb\n=========\nc\n>>>>>>>>> feature\n";
        let text = blocks(nine, 7, &none).expect("blocks").text;
        assert_eq!(text.blocks.len(), 1);
        assert_eq!(text.blocks[0].ours.label, "HEAD");
        // A shorter run before the markers is text, and the next run is tried.
        let quoted = b"<<< quoted\n<<<<<<<<< HEAD\nb\n=========\nc\n>>>>>>>>> feature\n";
        assert_eq!(
            blocks(quoted, 7, &none).expect("blocks").text.blocks.len(),
            1
        );
        // Without blocks at any size the attribute's reading stands.
        let stray = b"<<<<<<<<< x\ntext\n";
        let text = blocks(stray, 7, &none).expect("blocks").text;
        assert!(text.paired && text.blocks.is_empty());
        let unpaired = b"text\n>>>>>>> y\n";
        assert!(!blocks(unpaired, 7, &none).expect("blocks").text.paired);
    }

    #[test]
    fn a_block_a_version_holds_is_the_files_own_text() {
        // An example of git's markers that both sides keep, and one block git wrote.
        let example = b"<<<<<<< yours\nshop\n=======\nrelax\n>>>>>>> theirs\n";
        let with = |line: &[u8]| [example.as_slice(), line].concat();
        let versions = Versions::of(Some(&with(b"base\n")), &with(b"main\n"), &with(b"feat\n"));
        let file = with(b"<<<<<<< HEAD\nmain\n=======\nfeat\n>>>>>>> feature\n");
        let text = blocks(&file, 7, &versions).expect("blocks").text;
        assert_eq!(text.blocks.len(), 1);
        assert_eq!(text.blocks[0].ours.label, "HEAD");
        // Once git's block is written the example reads as text, at every size.
        let text = blocks(&with(b"main\n"), 32, &versions)
            .expect("blocks")
            .text;
        assert!(text.paired && text.blocks.is_empty());
        // A version holding the CRLF file's example without its CRs still holds it.
        let crlf = String::from_utf8(file.clone())
            .expect("utf-8")
            .replace('\n', "\r\n");
        let text = blocks(crlf.as_bytes(), 7, &versions).expect("blocks").text;
        assert_eq!(text.blocks.len(), 1);
    }
}
