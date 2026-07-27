//! The intra-node solution cache — Rust replacement for the per-process
//! global `TSCIRCUIT_AUTOROUTER_IN_MEMORY_CACHE`
//! (lib/cache/setupGlobalCaches.ts:24-28, lib/cache/InMemoryCache.ts:14-57).
//!
//! Deliberately a PLAIN struct: no globals, no interior mutability, no locks
//! (PORT-SPEC.md §5 "commit-on-sequential-semantics"). The M3 runtime owns
//! one `SharedCache` per Rust session and drives this protocol:
//!
//!   1. During a node, every candidate holds `&SharedCache` — an immutable
//!      snapshot of the PRE-NODE cache state. Within-node interaction is
//!      provably zero (two candidates of one node never share a key —
//!      distinct hyperparameters ⇒ distinct key, §5), so reads see exactly
//!      what the sequential schedule would have seen.
//!   2. Candidates never publish. A candidate that completes inside `_step`
//!      stages at most one entry, exposed via
//!      `CandidateSolver::pending_cache_entry()` (contract C2).
//!   3. After replay selection, M3 COMMITS only the entries the sequential
//!      schedule would have produced: candidates whose replay
//!      virtual-iterations reached completion when the winner landed
//!      (`v[i] >= iterations` in replay state) plus the winner, in
//!      candidate-index order (`commit` inserts in iteration order; later
//!      inserts overwrite, mirroring `Map.set`).
//!
//! Nodes run in sequential order at the top level, so this reproduces
//! sequential cache evolution exactly and REMOVES the extra-failure-entry
//! divergence class (the measured 1-in-550 cmn_51 mismatch, §5), not just
//! bounds it.
//!
//! Clone-on-read/clone-on-write (InMemoryCache.ts:29 `structuredClone` on
//! get, :56 on set) is preserved by ownership: `get` hands out a shared
//! reference and the candidate clones what it applies
//! (intra_node.rs `attempt_to_use_cache`); staged values are already owned
//! deep copies.
//!
//! Map iteration order is never observable (get/insert only — the TS
//! `getAllCacheKeys` has no consumer in this pipeline), so `HashMap` is safe
//! under determinism rule §6.6. Hit/miss counters (`stats.intraNodeCacheHits`,
//! HighDensitySolver.ts:497-501) are M3's bookkeeping, not stored here.

use std::collections::HashMap;

use crate::contract::{CacheValue, KeyHash};

#[derive(Default, Debug)]
pub struct SharedCache {
    entries: HashMap<KeyHash, CacheValue>,
}

impl SharedCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// `getCachedSolutionSync` minus the clone (the caller clones on apply).
    /// `None` == the TS `undefined` miss (InMemoryCache.ts:22-37).
    pub fn get(&self, key: &str) -> Option<&CacheValue> {
        self.entries.get(key)
    }

    /// `setCachedSolutionSync` (InMemoryCache.ts:54-57). Overwrites, like
    /// `Map.set`.
    pub fn insert(&mut self, key: KeyHash, value: CacheValue) {
        self.entries.insert(key, value);
    }

    /// Commit staged entries in the given order (M3: candidate-index order —
    /// the sequential completion order; see module docs step 3).
    pub fn commit<I: IntoIterator<Item = (KeyHash, CacheValue)>>(&mut self, staged: I) {
        for (k, v) in staged {
            self.entries.insert(k, v);
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}
