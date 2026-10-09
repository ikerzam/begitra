//! The local branches HEAD left most recently, as git counts them for `@{-N}`: HEAD's reflog (a
//! linked worktree's own), read from its end as git reads it there
//! (`files_for_each_reflog_ent_reverse`, `show_one_reflog_ent`): a line git takes for corrupt is
//! skipped (one cut short without its line feed, a malformed header, a time of 0), and each
//! `checkout: moving from <a> to <b>` entry, which `git switch` and `git checkout` write, gives
//! the `<a>` HEAD left, the first " to " ending it (`grab_nth_branch_switch`). A name counts once,
//! at its newest place, and only while it is a local branch: a detached HEAD left (its hash), a
//! branch deleted or renamed after the switch, HEAD's own branch and a name that is not UTF-8 drop
//! out, and the other entries (a commit, a reset, a rebase's steps, a rename) count no more than
//! they do for `@{-N}`. The newest [`SWITCHES`] switches are read, so a long run of detached
//! checkouts or deleted branches costs a bounded number of lookups.
//!
//! The file is read here rather than through libgit2, which creates a reflog when asked for a
//! missing one: the read must not write, and git appends to a reflog that exists whatever
//! `core.logAllRefUpdates` says.

use std::collections::HashSet;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use git2::{BranchType, Repository};

use super::Git2Engine;
use crate::error::GitResult;

/// The start of the message git writes on a switch or a checkout.
const MOVING_FROM: &[u8] = b"checkout: moving from ";

/// What ends the name HEAD left in that message, since a ref name holds no space.
const TO: &[u8] = b" to ";

/// Most switch entries read, newest first.
const SWITCHES: usize = 500;

/// Most bytes read from the end of the reflog: tens of thousands of lines, far more than
/// [`SWITCHES`] switches take.
const TAIL: u64 = 8 * 1024 * 1024;

/// See [`crate::engine::GitEngine::recent_branches`].
#[tracing::instrument(level = "debug", skip(engine))]
pub(super) fn recent_branches(engine: &Git2Engine, limit: usize) -> GitResult<Vec<String>> {
    engine.with_repo(|repo| Ok(left_branches(repo, limit)))
}

/// The names, newest first; none when HEAD has no reflog or it cannot be read.
fn left_branches(repo: &Repository, limit: usize) -> Vec<String> {
    // HEAD's reflog is in the worktree's own git folder, which `path` names.
    let reflog = match read_tail(&repo.path().join("logs").join("HEAD")) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            tracing::debug!(%error, "HEAD's reflog could not be read");
            return Vec::new();
        }
    };
    let current = repo
        .head()
        .ok()
        .filter(|head| head.is_branch())
        .and_then(|head| head.shorthand().ok().map(str::to_owned));
    let mut names: Vec<String> = Vec::new();
    // Every name looked at, kept or not, so each is looked up once.
    let mut seen: HashSet<String> = HashSet::new();
    let mut switches = 0;
    for line in lines_newest_first(&reflog) {
        if names.len() >= limit || switches >= SWITCHES {
            break;
        }
        let Some(left) = message(line).and_then(left_name) else {
            continue;
        };
        switches += 1;
        let Ok(left) = std::str::from_utf8(left) else {
            continue;
        };
        if current.as_deref() == Some(left) || !seen.insert(left.to_owned()) {
            continue;
        }
        if repo.find_branch(left, BranchType::Local).is_ok() {
            names.push(left.to_owned());
        }
    }
    names
}

/// The last [`TAIL`] bytes of the file at `path`, from the start of a line.
fn read_tail(path: &Path) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let start = file.metadata()?.len().saturating_sub(TAIL);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(TAIL).read_to_end(&mut bytes)?;
    if start > 0 {
        // The line the window cuts is not read.
        let cut = bytes
            .iter()
            .position(|&byte| byte == b'\n')
            .map_or(bytes.len(), |at| at + 1);
        bytes.drain(..cut);
    }
    Ok(bytes)
}

/// The lines of `reflog`, the newest first, without their line feed. A last line without one was
/// cut short (a crash, a full disk), and git skips it as corrupt.
fn lines_newest_first(reflog: &[u8]) -> impl Iterator<Item = &[u8]> {
    let end = reflog.iter().rposition(|&byte| byte == b'\n');
    end.and_then(|at| reflog.get(..at))
        .map(|complete| complete.rsplit(|&byte| byte == b'\n'))
        .into_iter()
        .flatten()
}

/// The message of a reflog line, or none for a line git skips as corrupt. Before the message:
/// `<old> <new> <name> <<email>> <time> <zone>`, two object ids, a time other than 0 and a zone
/// of a sign and four digits, then a tab or nothing.
fn message(line: &[u8]) -> Option<&[u8]> {
    let rest = object_id(line)?.strip_prefix(b" ")?;
    let rest = object_id(rest)?.strip_prefix(b" ")?;
    let email_end = rest.iter().position(|&byte| byte == b'>')?;
    let rest = rest.get(email_end + 1..)?.strip_prefix(b" ")?;
    // git reads the time with `strtoumax`, which takes blanks and a sign before the digits.
    let rest = rest.trim_ascii_start();
    let rest = rest
        .strip_prefix(b"+")
        .or_else(|| rest.strip_prefix(b"-"))
        .unwrap_or(rest);
    let digits = rest.iter().take_while(|byte| byte.is_ascii_digit()).count();
    let (time, rest) = rest.split_at_checked(digits)?;
    if time.iter().all(|&digit| digit == b'0') {
        return None;
    }
    let (sign, rest) = rest.strip_prefix(b" ")?.split_first()?;
    let (zone, rest) = rest.split_at_checked(4)?;
    if !matches!(sign, b'+' | b'-') || !zone.iter().all(u8::is_ascii_digit) {
        return None;
    }
    Some(rest.strip_prefix(b"\t").unwrap_or(rest))
}

/// What follows the object id that starts `line`: 40 or 64 hexadecimal digits.
fn object_id(line: &[u8]) -> Option<&[u8]> {
    let digits = line
        .iter()
        .take_while(|byte| byte.is_ascii_hexdigit())
        .count();
    if matches!(digits, 40 | 64) {
        line.get(digits..)
    } else {
        None
    }
}

/// The `<a>` of a `checkout: moving from <a> to <b>` message.
fn left_name(message: &[u8]) -> Option<&[u8]> {
    let rest = message.strip_prefix(MOVING_FROM)?;
    let end = rest.windows(TO.len()).position(|window| window == TO)?;
    rest.get(..end)
}

#[cfg(test)]
mod tests {
    use super::{left_name, lines_newest_first, message};

    const ID: &str = "0123456789abcdef0123456789abcdef01234567";

    fn line(header: &str, text: &str) -> Vec<u8> {
        format!("{ID} {ID} {header}\t{text}").into_bytes()
    }

    #[test]
    fn reads_a_line_as_git_does() {
        let good = line(
            "A U Thor <a@example.com> 1700000000 +0200",
            "checkout: moving from a to b",
        );
        assert_eq!(message(&good), Some(&b"checkout: moving from a to b"[..]));
        assert_eq!(message(&good).and_then(left_name), Some(&b"a"[..]));
        // Without a tab the message starts after the zone, as git reads it.
        let bare = format!("{ID} {ID} A <a@example.com> 1 -0000").into_bytes();
        assert_eq!(message(&bare), Some(&b""[..]));
        // `strtoumax` takes blanks before the time.
        let spaced = line("A <a@example.com>  1700000000 +0000", "x");
        assert_eq!(message(&spaced), Some(&b"x"[..]));
        // What git skips as corrupt.
        for header in [
            "A U Thor <a@example.com> 0 +0000",
            "A U Thor <a@example.com> 000 +0000",
            "A U Thor <a@example.com> 1700000000 0200",
            "A U Thor <a@example.com> 1700000000 +02",
            "A U Thor a@example.com 1700000000 +0000",
        ] {
            assert_eq!(
                message(&line(header, "checkout: moving from a to b")),
                None,
                "{header}"
            );
        }
        let short = format!("{} {ID} A <a@example.com> 1 +0000\tx", &ID[..39]).into_bytes();
        assert_eq!(message(&short), None);
    }

    #[test]
    fn reads_the_complete_lines_from_the_last() {
        let lines: Vec<&[u8]> = lines_newest_first(b"one\ntwo\nthree").collect();
        assert_eq!(lines, [&b"two"[..], &b"one"[..]]);
        assert_eq!(lines_newest_first(b"").count(), 0);
        assert_eq!(lines_newest_first(b"cut").count(), 0);
    }

    #[test]
    fn ends_the_name_at_the_first_to() {
        assert_eq!(
            left_name(b"checkout: moving from a to :/fix to x"),
            Some(&b"a"[..])
        );
        assert_eq!(left_name(b"commit: checkout: moving from b to a"), None);
        assert_eq!(left_name(b"checkout: moving from a"), None);
    }
}
