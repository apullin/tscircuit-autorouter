//! Shared contract types — PORT-SPEC.md §3 (input surface), §4 (output
//! surface), §8 C1/C2 (module contracts). Created by agent M2 because it did
//! not exist yet; other modules consume these, DO NOT redefine them.
//!
//! Deviations from the spec's pseudo-Rust, each chosen from TS truth and
//! flagged loudly (PORT-SPEC.md instructs pseudo-Rust; TS sources govern):
//!
//! 1. `NodeSession.node_id` is an owned `String` (spec: `&'a str`). Sessions
//!    are built once per node from the FFI JSON and shared by reference across
//!    ~75 candidates; owned inner data avoids a lifetime parameter for a
//!    1-6 KB/node payload (§3 "Serialized size per node").
//! 2. `PortPoint` carries `port_point_id` / `prev_port_point_id` /
//!    `next_port_point_id` (spec pseudo-Rust omits them, "pcb_port_id etc.
//!    stay TS-side"). TS truth: the v4 cache key serializes portPointId,
//!    prevPortPointId and nextPortPointId and SORTS by portPointId
//!    (CachedIntraNodeRouteSolver.ts:128-149). Without them, keys that TS
//!    distinguishes would collide in Rust — exactly the divergence class the
//!    commit-on-sequential cache policy exists to kill. pcb_port_id stays
//!    TS-side (annotation only, HighDensitySolver.ts:302-341).
//! 3. `Hp` gains `raw` (the marshaled hyperparameter object). TS truth: the
//!    cache key serializes `this.hyperParameters` — the raw candidate hp
//!    object with only its OWN keys, undefined-filtered and key-sorted
//!    (CachedIntraNodeRouteSolver.ts:151-155). Two hp objects that parse to
//!    identical typed fields (e.g. `{SHUFFLE_SEED: 0, ...}` vs the same
//!    object without the key — ORDERING_SHUFFLE_SEEDS includes 0,
//!    PortfolioSingleIntraNodeSolver.ts:39) MUST keep distinct keys.
//! 4. `CandidateRecord.max_iterations` and `CandidateSolver::max_iterations`
//!    are `f64` (spec: u64). TS truth: `MAX_ITERATIONS = 1_000 *
//!    totalConnections ** 1.5` (IntraNodeSolver.ts:173) is fractional (n=2 →
//!    2828.4271247461903); the golden capture compares it exactly
//!    (PORT-SPEC.md §7 "maxIterations equal") and the budget check
//!    `iterations > MAX_ITERATIONS` (BaseSolver.ts:45-51) compares against
//!    the float. RPLYDS01 stores it as a JS number
//!    (native/replay-core/datasetFormat.ts:58).
//! 5. `ConnSlice` embeds the string interner (names table). The spec's
//!    `HashMap<u32, u32>` shape is kept for the net maps, but every consumer
//!    (cache key strings, HdRoute names, error text) needs id→name, and the
//!    slice is the natural owner of the single intern namespace (connection
//!    names and net ids share one string universe —
//!    circuit-json-to-connectivity-map/dist/index.js:92-105 compares net ids
//!    against connection ids directly).

use std::collections::HashMap;

use crate::json::JVal;

// ---------------------------------------------------------------------------
// §3 Node-shared input
// ---------------------------------------------------------------------------

/// One port point of the node (lib/types/high-density-types.ts:1-11).
///
/// Marshaling rules (M3): `conn`/`root_conn` are interned into the session's
/// `ConnSlice`; `root_conn` must be `None` when TS `rootConnectionName` is
/// undefined OR "" (every TS consumer applies truthiness:
/// IntraNodeSolver.ts:124, getMinDistBetweenEnteringPoints.ts:19-24). An
/// empty-string root would be serialized into the TS cache key but is
/// collapsed to `None` here — flagged, never observed in the corpus. `z` is
/// required in the TS type; the defensive `z ?? 0` sites therefore reduce to
/// `z` (flagged assumption).
#[derive(Clone, Debug)]
pub struct PortPoint {
    pub conn: u32,
    pub root_conn: Option<u32>,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// Cache-key-only identity (CachedIntraNodeRouteSolver.ts:128-149).
    pub port_point_id: Option<String>,
    pub prev_port_point_id: Option<String>,
    pub next_port_point_id: Option<String>,
}

/// Node-shared candidate input — crosses the FFI once per node and is shared
/// read-only by all candidates (PORT-SPEC.md §3).
#[derive(Clone, Debug)]
pub struct NodeSession {
    /// capacityMeshNodeId; becomes `HdRoute.region_id`
    /// (IntraNodeSolver.ts:230, :298).
    pub node_id: String,
    pub center: [f64; 2],
    pub width: f64,
    pub height: f64,
    /// ORDER = TS array order (load-bearing: connection grouping order,
    /// IntraNodeSolver.ts:115-150; determinism list §6.2/§6.6).
    pub port_points: Vec<PortPoint>,
    pub available_z: Option<Vec<f64>>,
    /// Only feeds nodeSegmentCount (M3).
    pub port_points_in_pairs_len: Option<u32>,
    /// Defaults 0.15 / 0.3 / 0.15 / 1 (IntraNodeSolver.ts:112-114,
    /// PortfolioSingleIntraNodeSolver.ts:258) — M3 applies defaults when
    /// marshaling; fields here are always resolved.
    pub trace_width: f64,
    pub via_diameter: f64,
    pub obstacle_margin: f64,
    /// Consumed by M3 (supervisor budget) and the A01 class only.
    pub effort: f64,
    pub conn: ConnSlice,
}

/// The connMap slice: the net-lookup subset actually queried during a solve
/// (PORT-SPEC.md §3 "connMap queries"), over interned names.
///
/// Slice sufficiency: `{idToNet: name→net for the node's names, nets:
/// netMap[net] for those nets (+ netMap[name] if a name is itself a net id)}`.
/// Reference implementation:
/// node_modules/circuit-json-to-connectivity-map/dist/index.js:46-118.
///
/// Lookup-only maps — iteration order is never observable (§6.6), so
/// `HashMap` is safe here; the per-net id Vecs preserve the serialized array
/// order (`netMap[netId]` array order is returned verbatim, dist/index.js:93).
#[derive(Clone, Debug, Default)]
pub struct ConnSlice {
    names: Vec<String>,
    name_to_id: HashMap<String, u32>,
    id_to_net: HashMap<u32, u32>,
    nets: HashMap<u32, Vec<u32>>,
}

impl ConnSlice {
    pub fn new() -> Self {
        Self::default()
    }

    /// Intern a name (idempotent). M3 uses this while building the session;
    /// ids are internal-only and never cross back out.
    pub fn intern(&mut self, name: &str) -> u32 {
        if let Some(&id) = self.name_to_id.get(name) {
            return id;
        }
        let id = self.names.len() as u32;
        self.names.push(name.to_string());
        self.name_to_id.insert(name.to_string(), id);
        id
    }

    /// Id of an already-interned name.
    pub fn lookup(&self, name: &str) -> Option<u32> {
        self.name_to_id.get(name).copied()
    }

    pub fn resolve(&self, id: u32) -> &str {
        &self.names[id as usize]
    }

    /// `idToNetMap[id] = netId` (dist/index.js:50-55). Last write wins, as in
    /// the JS object.
    pub fn set_id_to_net(&mut self, id: u32, net: u32) {
        self.id_to_net.insert(id, net);
    }

    /// `netMap[netId] = ids` (array order preserved).
    pub fn set_net(&mut self, net: u32, ids: Vec<u32>) {
        self.nets.insert(net, ids);
    }

    /// Mirrors `getNetConnectedToId` (dist/index.js:95-97): raw idToNetMap
    /// lookup, `None` == undefined.
    pub fn get_net_connected_to_id(&self, id: u32) -> Option<u32> {
        self.id_to_net.get(&id).copied()
    }

    /// Mirrors `getIdsConnectedToNet` (dist/index.js:92-94):
    /// `netMap[netId] || []`. NOTE the cache key passes a CONNECTION name as
    /// the net id (CachedIntraNodeRouteSolver.ts:157-166, PORT-SPEC.md §3) —
    /// missing keys legitimately return the empty slice. A present-but-empty
    /// array is truthy in JS and is returned as-is, which this mirrors.
    pub fn get_ids_connected_to_net(&self, net_id: u32) -> &[u32] {
        self.nets.get(&net_id).map(|v| v.as_slice()).unwrap_or(&[])
    }

    /// Mirrors `areIdsConnected` (dist/index.js:98-105) — ASYMMETRIC on
    /// purpose (§6.11): the `netId1 === id2` mirror case is absent, and the
    /// `netId2 === id1` case is duplicated in the source:
    ///
    /// ```js
    /// if (id1 === id2) return true;
    /// const netId1 = this.idToNetMap[id1];
    /// if (!netId1) return false;
    /// const netId2 = this.idToNetMap[id2];
    /// if (!netId2) return false;
    /// return netId1 === netId2 || netId2 === id1 || netId2 === id1;
    /// ```
    ///
    /// JS `!netId` is falsy-checked: an empty-string net id counts as absent
    /// (mirrored via `resolve(net).is_empty()`; never occurs — net ids are
    /// "connectivity_netN" — kept for exactness).
    pub fn are_ids_connected(&self, id1: u32, id2: u32) -> bool {
        if id1 == id2 {
            return true;
        }
        let net1 = match self.id_to_net.get(&id1) {
            Some(&n) if !self.resolve(n).is_empty() => n,
            _ => return false,
        };
        let net2 = match self.id_to_net.get(&id2) {
            Some(&n) if !self.resolve(n).is_empty() => n,
            _ => return false,
        };
        net1 == net2 || net2 == id1
    }
}

// ---------------------------------------------------------------------------
// §3 Hyperparameters (dominant class)
// ---------------------------------------------------------------------------

/// Hyperparameters consumed by the dominant class (PORT-SPEC.md §3).
/// Typed-field defaults: SingleHighDensityRouteSolver6…ts:6-12 (assignment
/// loop :76-79), base CELL_SIZE_FACTOR `?? 1` at
/// SingleHighDensityRouteSolver.ts:154.
#[derive(Clone, Debug)]
pub struct Hp {
    pub cell_size_factor: f64, // default 1
    pub shuffle_seed: i32,     // 0 = NO shuffle (falsy check, IntraNodeSolver.ts:153)
    pub fut_trace_pen: f64,    // FUTURE_CONNECTION_PROX_TRACE_PENALTY_FACTOR, default 2
    pub fut_via_pen: f64,      // FUTURE_CONNECTION_PROX_VIA_PENALTY_FACTOR, default 1
    pub fut_prox_vd: f64,      // FUTURE_CONNECTION_PROXIMITY_VD, default 10
    pub misaligned_pen: f64,   // MISALIGNED_DIST_PENALTY_FACTOR, default 5
    pub via_pen2: f64,         // VIA_PENALTY_FACTOR_2, default 1
    pub flip_trace: bool,      // FLIP_TRACE_ALIGNMENT_DIRECTION, default false
    /// Raw marshaled hyperparameter object in TS enumeration/JSON order — the
    /// exact `this.hyperParameters` payload of the candidate
    /// (PortfolioSingleIntraNodeSolver.ts:1066-1069). The v4 cache key
    /// serializes THIS (deviation 3 in the module docs). JSON cannot carry
    /// `undefined`, so the TS `value !== undefined` filter
    /// (CachedIntraNodeRouteSolver.ts:153) is a no-op on marshaled input;
    /// `null` survives it and serializes as `null`, mirrored by `JVal::Null`.
    pub raw: Vec<(String, JVal)>,
}

impl Hp {
    /// Parse the typed fields out of the marshaled hp object. Presence checks
    /// mirror the TS reads: `hyperParameters[key] !== undefined` for the
    /// SHDRS6 assignment loop (:76-79), `?? 1` (nullish) for
    /// CELL_SIZE_FACTOR, missing SHUFFLE_SEED → 0. A NaN SHUFFLE_SEED is
    /// falsy in TS and maps to 0 here (`f64 as i32` saturates NaN→0).
    pub fn from_raw(raw: Vec<(String, JVal)>) -> Hp {
        fn num(raw: &[(String, JVal)], key: &str) -> Option<f64> {
            raw.iter()
                .find(|(k, _)| k == key)
                .and_then(|(_, v)| v.as_f64())
        }
        fn flag(raw: &[(String, JVal)], key: &str) -> Option<bool> {
            raw.iter()
                .find(|(k, _)| k == key)
                .and_then(|(_, v)| v.as_bool())
        }
        let cell_size_factor = num(&raw, "CELL_SIZE_FACTOR").unwrap_or(1.0);
        let shuffle_seed = num(&raw, "SHUFFLE_SEED").unwrap_or(0.0) as i32;
        let fut_trace_pen =
            num(&raw, "FUTURE_CONNECTION_PROX_TRACE_PENALTY_FACTOR").unwrap_or(2.0);
        let fut_via_pen = num(&raw, "FUTURE_CONNECTION_PROX_VIA_PENALTY_FACTOR").unwrap_or(1.0);
        let fut_prox_vd = num(&raw, "FUTURE_CONNECTION_PROXIMITY_VD").unwrap_or(10.0);
        let misaligned_pen = num(&raw, "MISALIGNED_DIST_PENALTY_FACTOR").unwrap_or(5.0);
        let via_pen2 = num(&raw, "VIA_PENALTY_FACTOR_2").unwrap_or(1.0);
        let flip_trace = flag(&raw, "FLIP_TRACE_ALIGNMENT_DIRECTION").unwrap_or(false);
        Hp {
            cell_size_factor,
            shuffle_seed,
            fut_trace_pen,
            fut_via_pen,
            fut_prox_vd,
            misaligned_pen,
            via_pen2,
            flip_trace,
            raw,
        }
    }
}

// ---------------------------------------------------------------------------
// §4 Candidate output surface
// ---------------------------------------------------------------------------

/// `HighDensityIntraNodeRoute` (lib/types/high-density-types.ts:37-58),
/// restricted to the fields this pipeline produces (per-point optionals and
/// jumpers never occur here; pcb-port annotation happens TS-side downstream).
#[derive(Clone, Debug, PartialEq)]
pub struct HdRoute {
    pub connection_name: String,
    pub root_connection_name: Option<String>,
    /// = capacityMeshNodeId (regionId).
    pub region_id: Option<String>,
    pub trace_thickness: f64,
    pub via_diameter: f64,
    /// x, y, z.
    pub route: Vec<[f64; 3]>,
    pub vias: Vec<[f64; 2]>,
}

/// Per-candidate record consumed by replay selection — exactly what
/// replayPool consumes (lib/parallel/replayPool.ts:10-20, 108-145) and
/// RPLYDS01 stores (native/replay-core/datasetFormat.ts:54-70).
#[derive(Clone, Debug)]
pub struct CandidateRecord {
    /// Position in the marshaled hp list = tie-break index.
    pub hp_index: u32,
    /// failed == ran to completion && !solved.
    pub solved: bool,
    /// Final BaseSolver.iterations.
    pub iterations: u64,
    /// Post-setup MAX_ITERATIONS (1000 * n**1.5 here). f64, NOT u64 —
    /// deviation 4 in the module docs.
    pub max_iterations: f64,
    /// -1 for the dominant class (only A01/A03 report >= 0,
    /// replayPool.ts:17, 197-201).
    pub solved_segments: i64,
    /// Schedule grid: sample k = raw progress after min((k+1)*100,
    /// iterations) iterations (datasetFormat.ts:76-89).
    pub traj: Vec<f32>,
    pub error: Option<String>,
    /// Kept thread-local; only the winner's routes cross the FFI.
    pub routes: Option<Vec<HdRoute>>,
}

// ---------------------------------------------------------------------------
// §8 C1 — sr-astar contract types (M1 implements `SrSolver` in sr_astar.rs)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub min_x: f64,
    pub max_x: f64,
    pub min_y: f64,
    pub max_y: f64,
}

/// One not-yet-solved connection. This is simultaneously the TS
/// `unsolvedConnections` element AND the `FutureConnection` type
/// (SingleHighDensityRouteSolver.ts:22-27): TS passes the live
/// `this.unsolvedConnections` array as `futureConnections`
/// (IntraNodeSolver.ts:245), so one struct serves both roles.
#[derive(Clone, Debug)]
pub struct FutureConn {
    pub conn: u32,
    pub root_conn: Option<u32>,
    pub points: Vec<[f64; 3]>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SrStatus {
    Running,
    Solved,
    Failed,
}

/// Contract C1 input (PORT-SPEC.md §8). Construction site:
/// `getSingleRouteSolverOpts` (IntraNodeSolver.ts:221-265). `SrSolver::new`
/// must copy everything it needs — the borrows do not outlive the call
/// (SrSolver carries no lifetime parameters; obstacle SoA arrays are built in
/// the ctor, SingleHighDensityRouteSolver.ts:535-629).
///
/// Identity fields (connectionName/rootConnectionName/regionId) are NOT here:
/// M2 overwrites them on every route it receives from `solved_path()`
/// (IntraNodeSolver.ts passes them through to solvedPath verbatim,
/// SingleHighDensityRouteSolver.ts:834-837 — overwriting with the same
/// values is identity). M1 may leave them empty/None.
///
/// `nearbySegmentClearance` is never passed by M2 → the solver6 super() call
/// computes it: `traceThickness/2 + obstacleMargin`
/// (SingleHighDensityRouteSolver6…ts:70-75; 0.225 at defaults). The base
/// default 0.15 (SingleHighDensityRouteSolver.ts:180) is DEAD on the dominant
/// path — corrected by M1 against TS truth; sr_astar implements the solver6
/// expression.
///
/// `available_z` is passed RAW (IntraNodeSolver.ts:250-258 has no
/// dedupe/sort on this path); M1 dedupes+sorts in its ctor
/// (SingleHighDensityRouteSolver.ts:173-176).
pub struct SrInput<'a> {
    pub conn: u32,
    pub a: [f64; 3],
    pub b: [f64; 3],
    pub bounds: Bounds,
    pub min_dist_between_entering_points: f64,
    pub obstacle_routes: &'a [HdRoute],
    pub future_connections: &'a [FutureConn],
    pub layer_count: u32,
    pub available_z: &'a [f64],
    pub hp: &'a Hp,
    pub conn_slice: &'a ConnSlice,
    pub via_diameter: f64,
    pub trace_thickness: f64,
    pub obstacle_margin: f64,
}

// Required M1 surface (implement in sr_astar.rs; text-only here so the
// contract file has no dependency on the pending module):
//
//   impl SrSolver {
//       pub fn new(input: SrInput) -> SrSolver;    // may solve in ctor
//                                                  // (handleSimpleCases,
//                                                  //  SingleHighDensityRouteSolver.ts:257-264, 310-334)
//       pub fn step(&mut self);                    // full BaseSolver.step semantics
//                                                  // (BaseSolver.ts:33-56: solved/failed
//                                                  //  short-circuit, iterations++ before _step,
//                                                  //  budget MAX_ITERATIONS=10_000 after,
//                                                  //  zero-arg progress recompute -> NaN, §6.3)
//       pub fn status(&self) -> SrStatus;
//       pub fn iterations(&self) -> u64;
//       pub fn solved_path(&self) -> Option<HdRoute>;
//       pub fn error(&self) -> Option<&str>;
//       pub fn is_endpoint_via_safe(&self) -> bool;
//           // isEndpointViaSafe (IntraNodeSolver.ts:592-631): with
//           // viaNode = {x: A.x, y: A.y, z: A.z, parent: {A, parent: null}}:
//           //   !( isNodeTooCloseToObstacle(viaNode,
//           //        viaDiameter/2 + obstacleMargin/2, /*isVia*/ true)   // :617-621
//           //   || isNodeTooCloseToEdge(viaNode, /*isVia*/ true) )       // :626
//           // (SingleHighDensityRouteSolver.ts:349-430, :432-451; the via
//           // parent-chain walk sees a single-node chain — no via hops.)
//   }
//
// SrSolver must be Send (M3 runs candidates on rayon threads).

// ---------------------------------------------------------------------------
// §8 C2 / §5 — cache contract types (owned by M2; committed by M3)
// ---------------------------------------------------------------------------

/// Cache map key. The C2 pseudo-contract names this `KeyHash`; TS truth is a
/// full composed key string in a `Map<string, …>`
/// (CachedIntraNodeRouteSolver.ts:201, lib/cache/InMemoryCache.ts:14) whose
/// string equality is collision-free by construction. A lossy numeric hash
/// could produce hits TS never had, so the full string is kept (§6.10: Rust
/// keys need only internal consistency).
pub type KeyHash = String;

/// Cached final outcome, INCLUDING FAILURES —
/// `CachedSolvedIntraNodeRouteSolver` (CachedIntraNodeRouteSolver.ts:10-12):
/// `{success:true, solvedRoutes}` | `{success:false, error?}`.
#[derive(Clone, Debug)]
pub enum CacheValue {
    Success { solved_routes: Vec<HdRoute> },
    Failure { error: Option<String> },
}
