//! Incremental lane layout for the commit graph.
//!
//! The "active lanes" algorithm: a
//! vector of lanes, each holding the commit it expects next; the state lives in the walk handle
//! so page boundaries never reset it.

/// Number of lanes drawn as columns. Lanes at or beyond this index are folded into the
/// `overflow` count of each row instead of adding columns.
pub const MAX_LANES: u32 = 12;
