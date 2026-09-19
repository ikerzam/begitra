//! File flag heuristics: generated, test and large files.
//!
//! `is_generated` combines `.gitattributes` `linguist-generated` with
//! lockfile and minified-file name heuristics; `is_test` is a path convention check; `is_large`
//! is over 5,000 changed lines or 1 MB on either side.
