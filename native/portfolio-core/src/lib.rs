//! portfolio-core — Rust port of the dominant intra-node candidate solver.
//!
//! AUTHORITATIVE SPEC: native/PORT-SPEC.md (worktree awt-perf-stack, branch
//! perf-ts-stack, commit 9b8eef54). All TS `file:line` citations in this crate
//! are against that worktree.
//!
//! Module ownership (PORT-SPEC.md §8 module split):
//!
//! | module            | agent | contents |
//! |-------------------|-------|----------|
//! | `contract`        | M2-created, SHARED | contract types of §3/§4/C1/C2 (do not redefine elsewhere) |
//! | `json`            | M3    | JSON parse + JSON.stringify-semantics writers (exists) |
//! | `geom_rng`        | M0    | JS number semantics (js_round/js_max/js_min/or_zero/js_to_fixed6), seeded_random + clone_and_shuffle (+PRESHUFFLED), vendored math-utils, node utils — LANDED |
//! | `sr_astar`        | M1    | `SrSolver` (the A* kernel + verbatim SingleRouteCandidatePriorityQueue) implementing contract C1 + is_endpoint_via_safe — LANDED |
//! | `js_num`          | M2    | JS number semantics needed by M2 (js_round, ToFixed, Number::toString, min/max) |
//! | `cache`           | M2    | `SharedCache` — plain struct, no locks; M3 owns snapshot/commit (§5) |
//! | `cache_key`       | M2    | v4 cache key composer (CachedIntraNodeRouteSolver.ts:111-208) |
//! | `intra_node`      | M2    | `CandidateSolver` — Cached+IntraNodeRouteSolver state machine (contract C2) |
//!
//! M0 NOTE (required by intra_node): `geom_rng` must export
//! `pub fn clone_and_shuffle<T: Clone>(arr: &[T], seed: i32) -> Vec<T>`
//! mirroring lib/utils/cloneAndShuffleArray.ts:80-105 bit-exactly (seed==0 →
//! plain clone, UNSHUFFLED; len 0 → clone; len<=4 → PRESHUFFLED_CASES
//! [seed % options.len()]; else xorshift128+ with JS int32 semantics, §6.1).
//!
//! M1 NOTE (required by intra_node): `sr_astar` must export `pub struct
//! SrSolver` with the C1 surface (see contract.rs docs) PLUS
//! `pub fn is_endpoint_via_safe(&self) -> bool` (IntraNodeSolver.ts:592-631).
//! The C1 shared types (SrInput/SrStatus/FutureConn/Bounds/Hp/HdRoute/
//! ConnSlice) already live in `contract` — implement ONLY the solver there.
//!
//! M3 NOTE: uncomment the runtime modules as they land. `CandidateRecord`,
//! `KeyHash`, `CacheValue`, `SharedCache` are defined in `contract`/`cache` —
//! consume, do not redefine. Cache commit policy is documented on
//! `cache::SharedCache` (§5 commit-on-sequential-semantics).

pub mod contract;
pub mod json;

pub mod geom_rng; // M0 — landed; exports clone_and_shuffle per the M0 NOTE.
pub mod sr_astar; // M1 — landed; SrSolver per the M1 NOTE + contract.rs C1 block.

pub mod cache;
pub mod cache_key;
pub mod intra_node;
pub mod js_num;

// M3 — landed (deps in Cargo.toml: replay-core path dep + rayon):
pub mod ffi;
pub mod replay_sim;
pub mod runtime;
pub mod seq; // mode "seq": live-sequential supervisor mirror (single-threaded)

pub use cache::SharedCache;
pub use contract::{
    Bounds, CacheValue, CandidateRecord, ConnSlice, FutureConn, HdRoute, Hp, KeyHash, NodeSession,
    PortPoint, SrInput, SrStatus,
};
pub use intra_node::CandidateSolver;
