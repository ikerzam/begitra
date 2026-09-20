//! The metadata predicate of a [`WalkFilter`], prepared once per walk and evaluated on the
//! raw commit before any row is built: the dates first (two integers), then the author and
//! the text over the raw message, the author's name and email and the hash prefix. An ASCII
//! needle is searched byte-wise with ASCII case folding and no allocation; a needle with
//! other characters falls back to Unicode lowercasing of the haystack.

use git2::{Commit, Oid};

use crate::types::WalkFilter;

/// A lowercased search text.
enum Needle {
    Ascii(Vec<u8>),
    Unicode(String),
}

impl Needle {
    fn new(text: &str) -> Option<Self> {
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        Some(if text.is_ascii() {
            Needle::Ascii(text.to_ascii_lowercase().into_bytes())
        } else {
            Needle::Unicode(text.to_lowercase())
        })
    }

    /// Whether the needle occurs in `haystack`, ignoring case.
    fn found_in(&self, haystack: &[u8]) -> bool {
        match self {
            Needle::Ascii(needle) => {
                let n = needle.len();
                haystack.len() >= n
                    && haystack
                        .windows(n)
                        .any(|window| window.eq_ignore_ascii_case(needle))
            }
            Needle::Unicode(needle) => String::from_utf8_lossy(haystack)
                .to_lowercase()
                .contains(needle.as_str()),
        }
    }

    /// Whether `oid`'s hex form starts with the needle.
    fn prefix_of(&self, oid: Oid) -> bool {
        let Needle::Ascii(needle) = self else {
            return false;
        };
        if needle.len() > 40 {
            return false;
        }
        const HEX: &[u8; 16] = b"0123456789abcdef";
        let bytes = oid.as_bytes();
        needle.iter().enumerate().all(|(i, &wanted)| {
            let byte = bytes[i / 2];
            let nibble = if i % 2 == 0 { byte >> 4 } else { byte & 0x0f };
            HEX[usize::from(nibble)] == wanted
        })
    }
}

/// The prepared predicate; `None` fields never reject.
pub(super) struct Matcher {
    text: Option<Needle>,
    author: Option<Needle>,
    /// The author needle names an identity (`Name <email>`), matched as git prints it.
    author_identity: bool,
    since: Option<i64>,
    until: Option<i64>,
}

/// Whether `signature`, printed as `Name <email>`, holds the needle.
fn identity_holds(signature: &git2::Signature<'_>, needle: &Needle) -> bool {
    let mut identity =
        Vec::with_capacity(signature.name_bytes().len() + signature.email_bytes().len() + 3);
    identity.extend_from_slice(signature.name_bytes());
    identity.extend_from_slice(b" <");
    identity.extend_from_slice(signature.email_bytes());
    identity.push(b'>');
    needle.found_in(&identity)
}

impl Matcher {
    pub(super) fn new(filter: &WalkFilter) -> Self {
        let author = filter.author.as_deref().map(str::trim).unwrap_or_default();
        Matcher {
            text: filter.text.as_deref().and_then(Needle::new),
            author: Needle::new(author),
            author_identity: author.contains('<') || author.contains('>'),
            since: filter.since,
            until: filter.until,
        }
    }

    /// Whether the metadata part of the filter (everything but `paths`) keeps `commit`.
    pub(super) fn matches(&self, commit: &Commit<'_>) -> bool {
        if self.since.is_some() || self.until.is_some() {
            let time = commit.committer().when().seconds();
            if self.since.is_some_and(|since| time < since) {
                return false;
            }
            if self.until.is_some_and(|until| time > until) {
                return false;
            }
        }
        if let Some(author) = &self.author {
            let signature = commit.author();
            let held = author.found_in(signature.name_bytes())
                || author.found_in(signature.email_bytes())
                || (self.author_identity && identity_holds(&signature, author));
            if !held {
                return false;
            }
        }
        if let Some(text) = &self.text {
            if text.found_in(commit.message_raw_bytes()) || text.prefix_of(commit.id()) {
                return true;
            }
            let signature = commit.author();
            return text.found_in(signature.name_bytes()) || text.found_in(signature.email_bytes());
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_needles_fold_case_without_unicode_lowering() {
        let needle = Needle::new("Fix(AUTH)").expect("needle");
        assert!(needle.found_in(b"fix(auth): handle 401"));
        assert!(needle.found_in(b"chore: FIX(auth) later"));
        assert!(!needle.found_in(b"fix (auth)"));
        assert!(!needle.found_in(b"fi"));
        assert!(Needle::new("   ").is_none());
    }

    #[test]
    fn unicode_needles_lowercase_the_haystack() {
        let needle = Needle::new("ÑANDÚ").expect("needle");
        assert!(needle.found_in("añade el ñandú".as_bytes()));
        assert!(!needle.found_in(b"nandu"));
    }

    #[test]
    fn hash_prefixes_match_without_allocating() {
        let oid = Oid::from_str("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678").expect("oid");
        assert!(Needle::new("A1B2c3").expect("needle").prefix_of(oid));
        assert!(Needle::new("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678")
            .expect("needle")
            .prefix_of(oid));
        assert!(!Needle::new("a1b2c4").expect("needle").prefix_of(oid));
        assert!(!Needle::new("ñ").expect("needle").prefix_of(oid));
        assert!(!Needle::new("a1b2c3d4e5f60718293a4b5c6d7e8f90123456789")
            .expect("needle")
            .prefix_of(oid));
    }
}
