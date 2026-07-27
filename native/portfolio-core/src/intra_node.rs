//! M2 `intra-node` — the candidate state machine (contract C2, PORT-SPEC.md
//! §8): `CachedIntraNodeRouteSolver` semantics, i.e. the cache layer
//! (lib/solvers/HighDensitySolver/CachedIntraNodeRouteSolver.ts:47-293)
//! implemented over the `IntraNodeRouteSolver` per-connection loop
//! (lib/solvers/HighDensitySolver/IntraNodeSolver.ts:52-590), with the
//! `BaseSolver.step` driver semantics (lib/solvers/BaseSolver.ts:33-56)
//! flattened in. One `CandidateSolver::step()` == one candidate iteration ==
//! one TS `Cached/IntraNode` `step()`.
//!
//! Iteration/budget/progress pipeline mirrored exactly (§6.3-6.4):
//! `iterations++` BEFORE `_step`; budget check `iterations > MAX_ITERATIONS`
//! AFTER (which can OVERWRITE a same-step `_step` error, and which never
//! reaches the cache because the save hook lives inside `_step` — TS never
//! caches iteration-exhaustion failures); unconditional zero-arg progress
//! recompute LAST.

use std::collections::HashSet;

use crate::cache::SharedCache;
use crate::cache_key::compute_cache_key_v4;
use crate::contract::{
    CacheValue, FutureConn, HdRoute, Hp, KeyHash, NodeSession, PortPoint, SrInput, SrStatus,
};
use crate::geom_rng::{
    clone_and_shuffle, get_bounds_from_node_with_port_points, get_min_dist_between_entering_points,
};
use crate::js_num::{js_max, js_min, js_number_to_string, js_to_fixed};
use crate::sr_astar::SrSolver;

/// IntraNodeSolver.ts:77
const POSTROUTE_VIA_TRACE_CLEARANCE: f64 = 0.1;
/// IntraNodeSolver.ts:78
const MAX_POSTROUTE_REPAIR_ATTEMPTS: u32 = 2;

/// A solved route plus its interned connection id (TS keys everything by
/// `route.connectionName`; the id avoids string compares while preserving
/// name-equality semantics — same intern namespace as the ConnSlice).
#[derive(Clone, Debug)]
struct SolvedRoute {
    conn: u32,
    route: HdRoute,
}

struct ActiveSub {
    conn: u32,
    root_conn: Option<u32>,
    solver: SrSolver,
}

struct ViaTraceConflict {
    route_conn: u32,
    via: [f64; 2],
    conflicting_conn: u32,
}

/// Contract C2. Borrows are shared and `Sync`-safe: M3 hands every candidate
/// of a node the same `&NodeSession` and the same pre-node `&SharedCache`
/// snapshot; the only mutable state is candidate-local. (Send-ness requires
/// M1's `SrSolver: Send`.)
pub struct CandidateSolver<'a> {
    session: &'a NodeSession,
    hp: &'a Hp,
    cache: &'a SharedCache,

    // --- BaseSolver state (BaseSolver.ts:10-15) ---
    solved: bool,
    failed: bool,
    iterations: u64,
    progress: f64,
    error: Option<String>,
    /// f64: `1_000 * totalConnections ** 1.5` (IntraNodeSolver.ts:173) is
    /// fractional — see contract.rs deviation 4.
    max_iterations: f64,

    // --- IntraNodeRouteSolver state ---
    unsolved_connections: Vec<FutureConn>,
    /// originalConnectionPointsByName (:135-142); lookup-only, tiny → Vec.
    original_connection_points_by_name: Vec<(u32, Vec<[f64; 3]>)>,
    /// rootConnectionNameByConnectionName (:116-129); last truthy root wins.
    root_connection_name_by_connection_name: Vec<(u32, u32)>,
    total_connections: usize,
    solved_routes: Vec<SolvedRoute>,
    /// `failedSubSolvers.map(s => s.error)` — only the error strings are ever
    /// consumed (:418); `[null].join` renders null as "", hence plain String.
    failed_sub_errors: Vec<String>,
    min_dist_between_entering_points: f64,
    reroute_attempts_by_connection: Vec<(u32, u32)>,
    active_sub_solver: Option<ActiveSub>,

    // --- CachedIntraNodeRouteSolver state (:59-70) ---
    cache_hit: bool,
    has_attempted_cache: bool,
    cache_key: Option<KeyHash>,
    /// Post-shuffle snapshot (:82) — feeds the v4 key.
    initial_unsolved_connections: Vec<FutureConn>,
    /// Staged (never published) cache write — M3 commits per §5.
    pending_cache_entry: Option<(KeyHash, CacheValue)>,
}

impl<'a> CandidateSolver<'a> {
    /// IntraNodeRouteSolver ctor (IntraNodeSolver.ts:93-197) +
    /// CachedIntraNodeRouteSolver ctor (CachedIntraNodeRouteSolver.ts:72-87).
    pub fn new(session: &'a NodeSession, hp: &'a Hp, cache: &'a SharedCache) -> Self {
        // :115-134 — insertion-order grouping of port points by connection
        // (JS Map ⇒ Vec, §6.6) and the root-name map (truthy roots only —
        // root_conn is None for undefined/"" by the contract marshaling
        // rule; Map.set overwrite ⇒ last truthy root wins).
        let mut root_by_conn: Vec<(u32, u32)> = Vec::new();
        let mut groups: Vec<(u32, Vec<[f64; 3]>)> = Vec::new();
        for pp in &session.port_points {
            if let Some(rc) = pp.root_conn {
                match root_by_conn.iter_mut().find(|(c, _)| *c == pp.conn) {
                    Some(slot) => slot.1 = rc,
                    None => root_by_conn.push((pp.conn, rc)),
                }
            }
            // {x, y, z: z ?? 0} (:132) — z is required in the TS type;
            // marshaling resolves it (contract.rs PortPoint docs).
            match groups.iter_mut().find(|(c, _)| *c == pp.conn) {
                Some(g) => g.1.push([pp.x, pp.y, pp.z]),
                None => groups.push((pp.conn, vec![[pp.x, pp.y, pp.z]])),
            }
        }

        // :135-150 — both structures are built from the same map entries
        // through the same pure dedupe; computed once and shared.
        let mut original_points: Vec<(u32, Vec<[f64; 3]>)> = Vec::with_capacity(groups.len());
        let mut unsolved: Vec<FutureConn> = Vec::with_capacity(groups.len());
        for (c, pts) in &groups {
            let deduped = dedupe_connection_points(pts);
            original_points.push((*c, deduped.clone()));
            unsolved.push(FutureConn {
                conn: *c,
                root_conn: root_by_conn.iter().find(|(k, _)| k == c).map(|(_, v)| *v),
                points: deduped,
            });
        }

        // :153-170 — TRUTHY gate: SHUFFLE_SEED 0 skips BOTH shuffles (§6.1).
        // Connections first, then each connection's points with seed
        // i * 7117 + SHUFFLE_SEED where i is the POST-shuffle index (§6.2).
        if hp.shuffle_seed != 0 {
            unsolved = clone_and_shuffle(&unsolved, hp.shuffle_seed);
            for (i, c) in unsolved.iter_mut().enumerate() {
                let shuffled = clone_and_shuffle(&c.points, (i as i32) * 7117 + hp.shuffle_seed);
                c.points = shuffled;
            }
        }

        let total_connections = unsolved.len(); // :172
        // :173 — 1_000 * n ** 1.5; f64 pow (glibc parity expected, §6.8;
        // validated per candidate by the golden `maxIterations` compare).
        let max_iterations = 1000.0 * (total_connections as f64).powf(1.5);
        // :175-177 — geom_rng's mirror of getMinDistBetweenEnteringPoints.ts
        let min_dist = get_min_dist_between_entering_points(session);

        // Cached ctor: post-shuffle snapshot (:82, cloneValue = deep clone).
        let initial_unsolved_connections = unsolved.clone();
        // :84-86 ctor-time save is dead code: the IntraNode ctor never sets
        // solved/failed (the no-crossings fast path is commented out,
        // IntraNodeSolver.ts:186-212).

        CandidateSolver {
            session,
            hp,
            cache,
            solved: false,
            failed: false,
            iterations: 0,
            progress: 0.0,
            error: None,
            max_iterations,
            unsolved_connections: unsolved,
            original_connection_points_by_name: original_points,
            root_connection_name_by_connection_name: root_by_conn,
            total_connections,
            solved_routes: Vec::new(),
            failed_sub_errors: Vec::new(),
            min_dist_between_entering_points: min_dist,
            reroute_attempts_by_connection: Vec::new(),
            active_sub_solver: None,
            cache_hit: false,
            has_attempted_cache: false,
            cache_key: None,
            initial_unsolved_connections,
            pending_cache_entry: None,
        }
    }

    // -----------------------------------------------------------------
    // Public surface (contract C2 + M3 bookkeeping accessors)
    // -----------------------------------------------------------------

    /// One candidate iteration — BaseSolver.step (BaseSolver.ts:33-56) over
    /// the Cached `_step`. (The TS try/catch around `_step` converts throws
    /// into failure + rethrow; the only in-closure throw is the packed-key
    /// capacity guard, SingleHighDensityRouteSolver.ts:231-243, which cannot
    /// fire on sane bounds — not modeled.)
    pub fn step(&mut self) {
        if self.solved {
            return; // :34
        }
        if self.failed {
            return; // :35
        }
        self.iterations += 1; // :36 — BEFORE _step
        self.cached_step(); // :38
        // :45-47 tryFinalAcceptance() is the BaseSolver no-op for this class.
        if !self.solved && (self.iterations as f64) > self.max_iterations {
            // :48-51 — unconditional error assignment: on the step where the
            // budget trips this OVERWRITES a same-step `_step` error, and
            // because the save hook already ran inside `_step`, budget
            // failures are NEVER cached. getSolverName() override:
            // "CachedIntraNodeRouteSolver" (CachedIntraNodeRouteSolver.ts:55-57).
            self.error = Some(format!(
                "CachedIntraNodeRouteSolver ran out of iterations (MAX_ITERATIONS={})",
                js_number_to_string(self.max_iterations)
            ));
            self.failed = true;
        }
        // :52-55 — unconditional zero-arg recompute (also runs on the
        // cache-hit step, overwriting applyCachedSolution's progress = 1).
        self.progress = self.compute_progress();
    }

    pub fn iterations(&self) -> u64 {
        self.iterations
    }

    /// f64, not u64 — contract deviation 4 (contract.rs docs).
    pub fn max_iterations(&self) -> f64 {
        self.max_iterations
    }

    /// Raw, unclamped (may exceed 1; NaN for a 0-connection node) — feeds the
    /// schedule-grid trajectory and pre-expansion computeH (§6.3).
    pub fn progress(&self) -> f64 {
        self.progress
    }

    pub fn status(&self) -> SrStatus {
        if self.solved {
            SrStatus::Solved
        } else if self.failed {
            SrStatus::Failed
        } else {
            SrStatus::Running
        }
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub fn cache_hit(&self) -> bool {
        self.cache_hit
    }

    /// The composed v4 key, if computed (iteration >= 1). M3 stats only.
    pub fn cache_key(&self) -> Option<&str> {
        self.cache_key.as_deref()
    }

    /// Raw `solvedRoutes` (extractWinningRoutes runs TS-side, §2b).
    pub fn take_routes(self) -> Vec<HdRoute> {
        self.solved_routes.into_iter().map(|sr| sr.route).collect()
    }

    /// The staged cache write, if this candidate completed inside `_step`
    /// (cache hits and budget failures stage nothing). Committed by M3 per
    /// the §5 commit-on-sequential-semantics policy (cache.rs docs).
    pub fn pending_cache_entry(&self) -> Option<(KeyHash, CacheValue)> {
        self.pending_cache_entry.clone()
    }

    // -----------------------------------------------------------------
    // CachedIntraNodeRouteSolver layer
    // -----------------------------------------------------------------

    /// `_step` (CachedIntraNodeRouteSolver.ts:89-109).
    fn cached_step(&mut self) {
        // :90-94 — one attempt ever; a MISS falls through to the real step
        // in the SAME iteration (no extra iteration cost), a HIT consumes
        // this iteration.
        if !self.has_attempted_cache && self.attempt_to_use_cache() {
            return;
        }
        let was_solved = self.solved; // :96
        let was_failed = self.failed; // :97
        self.intra_step(); // :99 super._step()
        // :101-108
        if !self.cache_hit && (self.solved || self.failed) && !(was_solved || was_failed) {
            self.stage_save();
        }
    }

    /// attemptToUseCacheSync (:228-262). The SharedCache is always sync and
    /// always present (a disabled cache is an EMPTY SharedCache: identical
    /// step accounting, M3 discards the staged entries). Key computation
    /// cannot throw, so the TS error guards vanish.
    fn attempt_to_use_cache(&mut self) -> bool {
        self.has_attempted_cache = true; // :229
        self.ensure_cache_key(); // :234-246
        let key = self.cache_key.as_ref().expect("ensure_cache_key sets it");
        // :248-256 — getCachedSolutionSync; clone-on-read mirrors
        // InMemoryCache.ts:29 structuredClone.
        if let Some(value) = self.cache.get(key).cloned() {
            self.applied_cached_solution(value);
            return true;
        }
        false // miss (undefined) → caller falls through to the real step
    }

    fn ensure_cache_key(&mut self) {
        if self.cache_key.is_none() {
            self.cache_key = Some(compute_cache_key_v4(
                self.session,
                &self.hp.raw,
                &self.initial_unsolved_connections,
                self.min_dist_between_entering_points,
            ));
        }
    }

    /// applyCachedSolution (:210-226).
    fn applied_cached_solution(&mut self, value: CacheValue) {
        match value {
            CacheValue::Success { solved_routes } => {
                // :212 — the value is already an owned deep copy. Conn ids
                // re-derived by name: a v4 hit implies identical connection
                // names (they are serialized into the key), so lookups
                // resolve; u32::MAX is an unreachable sentinel.
                self.solved_routes = solved_routes
                    .into_iter()
                    .map(|route| SolvedRoute {
                        conn: self
                            .session
                            .conn
                            .lookup(&route.connection_name)
                            .unwrap_or(u32::MAX),
                        route,
                    })
                    .collect();
                self.solved = true; // :213
                self.failed = false; // :214
            }
            CacheValue::Failure { error } => {
                self.solved_routes.clear(); // :216
                self.failed_sub_errors.clear(); // :217
                self.solved = false; // :218
                self.failed = true; // :219
                // :220 `cachedSolution.error ?? this.error`
                if error.is_some() {
                    self.error = error;
                }
            }
        }
        self.unsolved_connections.clear(); // :222
        self.active_sub_solver = None; // :223
        self.cache_hit = true; // :224
        // :225 — overwritten by the end-of-step recompute; the OBSERVABLE
        // post-hit progress is solvedRoutes.length / totalConnections
        // (0 for a failure hit). Kept for pipeline fidelity.
        self.progress = 1.0;
    }

    /// saveToCacheSync (:264-292), publishing replaced by staging (§5).
    fn stage_save(&mut self) {
        self.ensure_cache_key(); // :269-281 (already set on the attempt path)
        let value = if self.failed {
            // :283-284 {success:false, error: this.error ?? undefined}
            CacheValue::Failure {
                error: self.error.clone(),
            }
        } else {
            // :285 {success:true, solvedRoutes: cloneValue(this.solvedRoutes)}
            CacheValue::Success {
                solved_routes: self.solved_routes.iter().map(|sr| sr.route.clone()).collect(),
            }
        };
        // :288 setCachedSolutionSync → staged for M3's commit.
        self.pending_cache_entry = Some((
            self.cache_key.clone().expect("ensure_cache_key sets it"),
            value,
        ));
    }

    // -----------------------------------------------------------------
    // IntraNodeRouteSolver layer
    // -----------------------------------------------------------------

    /// computeProgress (IntraNodeSolver.ts:214-219):
    /// `(solvedRoutes.length + (activeSubSolver?.progress || 0)) / totalConnections`.
    ///
    /// The sub-solver term is PROVABLY 0 at every observation point, so C1
    /// needs no progress accessor: a fresh sub-solver has progress 0 and is
    /// never observed before its first step (the spawn step computes
    /// progress before assignment, :425 vs :483); after any step() the
    /// zero-arg BaseSolver recompute poisons it to NaN (§6.3 B2:
    /// BaseSolver.ts:52-55 calls computeProgress() with no args →
    /// `undefined + number` → NaN through Math.max, SingleHighDensityRouteSolver.ts:847-864);
    /// a ctor-solved sub short-circuits step() with progress still 0.
    /// `NaN || 0 → 0`, `±0 || 0 → 0` (js_num::or_zero). The ratio can
    /// EXCEED 1 (multipoint branches push extra routes while
    /// totalConnections stays fixed) and is NaN (0/0) for an empty node —
    /// both mirrored by IEEE division.
    fn compute_progress(&self) -> f64 {
        (self.solved_routes.len() as f64 + 0.0) / (self.total_connections as f64)
    }

    /// `_step` (IntraNodeSolver.ts:408-487).
    fn intra_step(&mut self) {
        // --- active sub-solver branch (:409-422) ---
        if self.active_sub_solver.is_some() {
            let status = {
                let active = self.active_sub_solver.as_mut().expect("checked");
                active.solver.step(); // :410 (no-op if ctor-solved: BaseSolver short-circuit)
                active.solver.status()
            };
            self.progress = self.compute_progress(); // :411 — pre-push value
            match status {
                SrStatus::Solved => {
                    // :412-414
                    let active = self.active_sub_solver.take().expect("checked");
                    let mut route = active.solver.solved_path().expect(
                        "SrStatus::Solved implies solvedPath (SingleHighDensityRouteSolver.ts:823-845)",
                    );
                    // Identity fields travel opts → solvedPath verbatim in TS
                    // (IntraNodeSolver.ts:227-231 →
                    // SingleHighDensityRouteSolver.ts:834-837); M2 owns them
                    // under contract C1 (contract.rs SrInput docs).
                    route.connection_name =
                        self.session.conn.resolve(active.conn).to_string();
                    route.root_connection_name = active
                        .root_conn
                        .map(|rc| self.session.conn.resolve(rc).to_string());
                    route.region_id = Some(self.session.node_id.clone());
                    self.solved_routes.push(SolvedRoute {
                        conn: active.conn,
                        route,
                    });
                }
                SrStatus::Failed => {
                    // :415-420 — first sub-solver failure fails the whole
                    // candidate. `[error].join("\n")` renders a null error
                    // as "" — mirrored by unwrap_or_default.
                    let active = self.active_sub_solver.take().expect("checked");
                    self.failed_sub_errors.push(
                        active
                            .solver
                            .error()
                            .map(str::to_string)
                            .unwrap_or_default(),
                    );
                    self.error = Some(self.failed_sub_errors.join("\n")); // :418
                    self.failed = true; // :419
                }
                SrStatus::Running => {}
            }
            return; // :421
        }

        // --- pop one unsolved connection, LIFO (:424-425, §6.2) ---
        let popped = self.unsolved_connections.pop();
        self.progress = self.compute_progress();
        let Some(uc) = popped else {
            // --- queue empty: repair check, then success (:426-457) ---
            if let Some(conflict) = self.first_solved_via_trace_conflict() {
                let attempts = self
                    .reroute_attempts_by_connection
                    .iter()
                    .find(|(c, _)| *c == conflict.route_conn)
                    .map(|(_, n)| *n)
                    .unwrap_or(0); // :429-432
                if attempts >= MAX_POSTROUTE_REPAIR_ATTEMPTS {
                    // :434-443
                    self.error = Some(
                        [
                            "Post-route via/trace clearance repair exceeded retry budget"
                                .to_string(),
                            format!(
                                "route: {}",
                                self.session.conn.resolve(conflict.route_conn)
                            ),
                            format!(
                                "conflicts with: {}",
                                self.session.conn.resolve(conflict.conflicting_conn)
                            ),
                            format!(
                                "via: ({}, {})",
                                js_to_fixed(conflict.via[0], 3),
                                js_to_fixed(conflict.via[1], 3)
                            ),
                        ]
                        .join("\n"),
                    );
                    self.failed = true;
                    return;
                }
                if self.queue_connection_for_postroute_repair(conflict.route_conn) {
                    // :445-453
                    self.progress = self.compute_progress();
                    return;
                }
                // queue false (unrepairable) → fall through to :455
            }
            self.solved = self.failed_sub_errors.is_empty(); // :455
            return;
        };

        // --- degenerate single point (:458-460): dropped without a route ---
        if uc.points.len() == 1 {
            return;
        }
        // --- multipoint branching (:461-465) ---
        if uc.points.len() > 2 && self.queue_extra_branches_for_multi_point_connection(&uc) {
            return;
        }
        // --- 2-point same-position fast paths (:466-482) ---
        if uc.points.len() == 2 {
            let a = uc.points[0];
            let b = uc.points[1];
            let same_x = (a[0] - b[0]).abs() < 1e-6; // :468
            let same_y = (a[1] - b[1]).abs() < 1e-6; // :469
            if same_x && same_y && a[2] == b[2] {
                return; // :471-473 — dropped without a route
            }
            if same_x && same_y && a[2] != b[2] && self.try_solve_same_point_layer_change(&uc) {
                return; // :479-481
            }
        }
        // --- spawn the A* (:483-486) — NOT stepped this iteration ---
        let sub = self.make_sub_solver(&uc);
        self.active_sub_solver = Some(ActiveSub {
            conn: uc.conn,
            root_conn: uc.root_conn,
            solver: sub,
        });
    }

    /// getSingleRouteSolverOpts (:221-265) + the SHDRS6 construction
    /// (:483-486). Also serves as the obstacle-checker factory for the
    /// same-point fast path (:272-274).
    fn make_sub_solver(&self, uc: &FutureConn) -> SrSolver {
        let a = uc.points[0]; // :233 — points.len() >= 2 at every call site
        let b = *uc.points.last().expect("non-empty points"); // :234-238
        // :239-244 — connMap-present branch: obstacle view EXCLUDES routes of
        // the same or a connected connection. Asymmetric call order is
        // load-bearing: areIdsConnected(solvedRoute.conn, currentConn).
        // (The connMap-absent branch — unfiltered view — is not modeled;
        // session.conn is required. Flagged in contract.rs.)
        let obstacle_routes: Vec<HdRoute> = self
            .solved_routes
            .iter()
            .filter(|sr| !self.session.conn.are_ids_connected(sr.conn, uc.conn))
            .map(|sr| sr.route.clone())
            .collect();
        // :246-249 layerCount = portPoints.reduce(max(max, (z ?? 0) + 1), 2)
        let mut layer_count = 2.0_f64;
        for p in &self.session.port_points {
            layer_count = js_max(layer_count, p.z + 1.0);
        }
        // :250-258 availableZ — RAW when present + non-empty (no dedupe/sort
        // on this path; M1 dedupes+sorts in its ctor), else derived from
        // port-point z values.
        let derived: Vec<f64>;
        let available_z: &[f64] = if let Some(az) = self
            .session
            .available_z
            .as_ref()
            .filter(|v| !v.is_empty())
        {
            az.as_slice()
        } else {
            derived = derive_port_z_layers(&self.session.port_points);
            &derived
        };
        let input = SrInput {
            conn: uc.conn,
            a,
            b,
            bounds: get_bounds_from_node_with_port_points(self.session), // :232
            min_dist_between_entering_points: self.min_dist_between_entering_points, // :231
            obstacle_routes: &obstacle_routes,
            // :245 — the LIVE remaining list (immutable while a sub-solver
            // is active, so a borrow at ctor time is snapshot-equivalent).
            future_connections: &self.unsolved_connections,
            layer_count: layer_count as u32,
            available_z,
            hp: self.hp,                                 // :259
            conn_slice: &self.session.conn,              // :260
            via_diameter: self.session.via_diameter,     // :261
            trace_thickness: self.session.trace_width,   // :262
            obstacle_margin: self.session.obstacle_margin, // :263
        };
        SrSolver::new(input)
    }

    /// trySolveSamePointLayerChange (:267-305). Only reached when
    /// same_x && same_y && A.z != B.z.
    fn try_solve_same_point_layer_change(&mut self, uc: &FutureConn) -> bool {
        let a = uc.points[0];
        let b = *uc.points.last().expect("non-empty points");
        // :272-278 — a full SHDRS6 instance is built from the same opts as an
        // obstacle checker and discarded; on the false path `_step` builds a
        // FRESH instance (:483-486) exactly as TS does.
        let via_safe = {
            let checker = self.make_sub_solver(uc);
            checker.is_endpoint_via_safe() // isEndpointViaSafe (:592-631)
        };
        if !via_safe {
            return false;
        }
        let via = [a[0], a[1]]; // :276 viaPoint = {x: A.x, y: A.y}
        // :282-293 — 4-point polyline filtered against the ORIGINAL previous
        // element (JS Array.filter exposes the source array, not the output).
        let raw: [[f64; 3]; 4] = [
            [a[0], a[1], a[2]],
            [via[0], via[1], a[2]],
            [via[0], via[1], b[2]],
            [b[0], b[1], b[2]],
        ];
        let mut route_pts: Vec<[f64; 3]> = Vec::with_capacity(4);
        for (idx, pt) in raw.iter().enumerate() {
            let keep = idx == 0 || {
                let prev = raw[idx - 1];
                (pt[0] - prev[0]).abs() > 1e-6
                    || (pt[1] - prev[1]).abs() > 1e-6
                    || pt[2] != prev[2]
            };
            if keep {
                route_pts.push(*pt);
            }
        }
        // :295-303
        self.solved_routes.push(SolvedRoute {
            conn: uc.conn,
            route: HdRoute {
                connection_name: self.session.conn.resolve(uc.conn).to_string(),
                root_connection_name: uc
                    .root_conn
                    .map(|rc| self.session.conn.resolve(rc).to_string()),
                region_id: Some(self.session.node_id.clone()), // :298 regionId
                trace_thickness: self.session.trace_width,     // :299
                via_diameter: self.session.via_diameter,       // :300
                route: route_pts,
                vias: vec![via], // :302
            },
        });
        true
    }

    /// queueExtraBranchesForMultiPointConnection (:307-327).
    fn queue_extra_branches_for_multi_point_connection(&mut self, uc: &FutureConn) -> bool {
        // :312-314 — dedupe again (input is already deduped; pure fn kept
        // for fidelity), then [origin, ...extraPoints].
        let deduped = dedupe_connection_points(&uc.points);
        if deduped.is_empty() {
            return false; // !origin
        }
        let origin = deduped[0];
        let extra = &deduped[1..];
        if extra.len() <= 1 {
            return false; // :316
        }
        for point in extra {
            // :318-324 — pushed in order; LIFO pop runs the LAST branch first.
            self.unsolved_connections.push(FutureConn {
                conn: uc.conn,
                root_conn: uc.root_conn,
                points: vec![origin, *point],
            });
        }
        true // :326
    }

    /// getAvailableZLayers (:329-344) — repair path; unlike the opts path
    /// this one DOES dedupe+numeric-sort a present availableZ.
    fn available_z_layers_for_repair(&self) -> Vec<f64> {
        if let Some(az) = self
            .session
            .available_z
            .as_ref()
            .filter(|v| !v.is_empty())
        {
            let mut out: Vec<f64> = Vec::with_capacity(az.len());
            for &z in az.iter() {
                if !out.iter().any(|&s| s == z) {
                    out.push(z); // Set semantics: first occurrence, ±0 merged
                }
            }
            out.sort_by(f64::total_cmp); // (a, b) => a - b; no NaN, ±0 deduped
            return out;
        }
        derive_port_z_layers(&self.session.port_points) // :339-343
    }

    /// getFirstSolvedViaTraceConflict (:346-384), with the spatial index
    /// replaced by a direct scan — PORT-SPEC.md §6.14: every consumer
    /// early-outs on ANY hit, so the conflict BOOLEAN is order-independent;
    /// only which conflicting route is reported depends on iteration order,
    /// and that feeds error text alone (here: deterministic solvedRoutes
    /// order instead of TS bucket-discovery order — flagged, sanctioned).
    fn first_solved_via_trace_conflict(&self) -> Option<ViaTraceConflict> {
        if self.solved_routes.len() < 2 {
            return None; // :347
        }
        let available_z = self.available_z_layers_for_repair(); // :350
        for route in &self.solved_routes {
            // :353 margin = route.viaDiameter / 2 + POSTROUTE_VIA_TRACE_CLEARANCE
            let margin = route.route.via_diameter / 2.0 + POSTROUTE_VIA_TRACE_CLEARANCE;
            for via in &route.route.vias {
                for &z in &available_z {
                    // getConflictingRoutesNearPoint({x, y, z}, margin)
                    // .filter(name mismatch && !connected) — filter :359-370:
                    // same-NAME routes (branches included) are exempt, then
                    // connMap-connected routes (`?? false` keeps the
                    // conflict when no connMap; present-branch modeled).
                    for other in &self.solved_routes {
                        if other.conn == route.conn {
                            continue; // :360-362 name equality
                        }
                        if self
                            .session
                            .conn
                            .are_ids_connected(route.conn, other.conn)
                        {
                            continue; // :364-369
                        }
                        if route_conflicts_near_point(&other.route, via[0], via[1], z, margin) {
                            // :372-378 conflicts[0]
                            return Some(ViaTraceConflict {
                                route_conn: route.conn,
                                via: *via,
                                conflicting_conn: other.conn,
                            });
                        }
                    }
                }
            }
        }
        None // :383
    }

    /// queueConnectionForPostrouteRepair (:386-406).
    fn queue_connection_for_postroute_repair(&mut self, conn_id: u32) -> bool {
        let points = self
            .original_connection_points_by_name
            .iter()
            .find(|(c, _)| *c == conn_id)
            .map(|(_, pts)| pts.clone());
        let Some(points) = points else {
            return false; // :388-390
        };
        if points.len() < 2 {
            return false;
        }
        // :392-394 — drops EVERY route of that connection (branch routes too).
        self.solved_routes.retain(|r| r.conn != conn_id);
        // :395-400 — root from the ctor map; points value-cloned above.
        let root = self
            .root_connection_name_by_connection_name
            .iter()
            .find(|(c, _)| *c == conn_id)
            .map(|(_, r)| *r);
        self.unsolved_connections.push(FutureConn {
            conn: conn_id,
            root_conn: root,
            points,
        });
        // :401-404
        match self
            .reroute_attempts_by_connection
            .iter_mut()
            .find(|(c, _)| *c == conn_id)
        {
            Some(slot) => slot.1 += 1,
            None => self.reroute_attempts_by_connection.push((conn_id, 1)),
        }
        true // :405
    }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

/// pointKey (IntraNodeSolver.ts:35-36):
/// `${x.toFixed(6)},${y.toFixed(6)},${z}` — exact JS ToFixed (half-away-
/// from-zero decimal ties DO occur on dyadic mesh coordinates, §6.9) and
/// Number::toString for z.
fn point_key(p: &[f64; 3]) -> String {
    format!(
        "{},{},{}",
        js_to_fixed(p[0], 6),
        js_to_fixed(p[1], 6),
        js_number_to_string(p[2])
    )
}

/// dedupeConnectionPoints (IntraNodeSolver.ts:38-50): Set-keyed, first
/// occurrence wins, order preserved.
fn dedupe_connection_points(points: &[[f64; 3]]) -> Vec<[f64; 3]> {
    let mut seen: HashSet<String> = HashSet::with_capacity(points.len());
    let mut out: Vec<[f64; 3]> = Vec::with_capacity(points.len());
    for p in points {
        if seen.insert(point_key(p)) {
            out.push(*p);
        }
    }
    out
}

// getBoundsFromNodeWithPortPoints and getMinDistBetweenEnteringPoints live in
// geom_rng (M0's node-utils section, verified semantics-identical to the TS:
// strict-comparison bounds expansion; raw-z + truthy-root pair skips; js_min).

/// `[...new Set(portPoints.map(p => p.z ?? 0))].sort((a, b) => a - b)` —
/// identical code at IntraNodeSolver.ts:254-258 (opts fallback) and
/// :339-343 (repair fallback). Set keeps the first occurrence (SameValueZero
/// merges ±0); numeric sort.
fn derive_port_z_layers(port_points: &[PortPoint]) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::new();
    for p in port_points {
        if !out.iter().any(|&s| s == p.z) {
            out.push(p.z);
        }
    }
    out.sort_by(f64::total_cmp);
    out
}

/// Does `route` conflict with a query point (x, y) on layer z within
/// `margin`? Direct-scan mirror of
/// HighDensityRouteSpatialIndex.getConflictingRoutesNearPoint
/// (lib/data-structures/HighDensityRouteSpatialIndex.ts:418-516) restricted
/// to one route, including addRoute's indexing skips (:345-352).
fn route_conflicts_near_point(route: &HdRoute, x: f64, y: f64, z: f64, margin: f64) -> bool {
    // --- segments: same-layer copper only (:451-453) ---
    if route.route.len() >= 2 {
        // addRoute :345 gate
        // :468 requiredSeparation = margin + traceThickness / 2, strict <
        let req = margin + route.trace_thickness / 2.0;
        let req_sq = req * req;
        for w in route.route.windows(2) {
            let p1 = w[0];
            let p2 = w[1];
            if p1[0] == p2[0] && p1[1] == p2[1] {
                continue; // addRoute :350 — zero-length (pure via) segments never indexed
            }
            if p1[2] != p2[2] || p1[2] != z {
                continue; // :453
            }
            if point_to_segment_distance_sq(x, y, p1[0], p1[1], p2[0], p2[1]) < req_sq {
                return true; // :473
            }
        }
    }
    // --- vias: NOT z-filtered — a via spans every layer (:487-513) ---
    let req = margin + route.via_diameter / 2.0; // :497
    let req_sq = req * req;
    for v in &route.vias {
        // computeDistSq(point, viaPoint) (:500, :51-55)
        let dx = x - v[0];
        let dy = y - v[1];
        if dx * dx + dy * dy < req_sq {
            return true; // :502
        }
    }
    false
}

/// pointToSegmentDistanceSq (HighDensityRouteSpatialIndex.ts:57-67),
/// operation-for-operation (clamp via JS Math.max/Math.min semantics).
fn point_to_segment_distance_sq(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    // l2 = computeDistSq(a, b)
    let dx = ax - bx;
    let dy = ay - by;
    let l2 = dx * dx + dy * dy;
    if l2 == 0.0 {
        // segment is a point (unreachable behind the zero-length skip; kept)
        let dx = px - ax;
        let dy = py - ay;
        return dx * dx + dy * dy;
    }
    let t = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / l2;
    let t = js_max(0.0, js_min(1.0, t));
    let proj_x = ax + t * (bx - ax);
    let proj_y = ay + t * (by - ay);
    let dx = px - proj_x;
    let dy = py - proj_y;
    dx * dx + dy * dy
}
