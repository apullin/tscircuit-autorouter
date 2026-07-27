//! M1 `sr-astar` (PORT-SPEC.md §8, contract C1) — the A* kernel, agent B.
//!
//! Ports, flattened into one struct (only the "solver 6" subclass is ever
//! instantiated by the dominant class — IntraNodeSolver.ts:483-486):
//!
//!   - lib/solvers/HighDensitySolver/SingleHighDensityRouteSolver.ts
//!     (the A* loop :866-922 and everything it reaches: packed keys, obstacle
//!     predicates in linear-scan SoA form, simple-case fast path, path
//!     reconstruction, BaseSolver step/budget/progress semantics).
//!   - lib/solvers/HighDensitySolver/
//!     SingleHighDensityRouteSolver6_VertHorzLayer_FutureCost.ts
//!     (cost overrides, future-connection machinery, via-vs-future-trace
//!     obstacle extension). `diminishCloseToGoal` (:226-229) is dead code and
//!     not ported (PORT-SPEC §1).
//!   - lib/data-structures/SingleRouteCandidatePriorityQueue.ts — verbatim
//!     (§6.5: equal-f pop order comes from these exact comparisons plus
//!     insertion order; any "equivalent" heap changes routes).
//!
//! Class flattening note: TS field-initialization/ctor order is preserved
//! exactly — base-ctor work first (VIA_PENALTY_FACTOR = 0.3,
//! NEARBY_SEGMENT_CLEARANCE from the solver6 super() expression, simple-case
//! handling, initial queue), THEN the solver6 ctor tail (VIA_PENALTY_FACTOR
//! recompute, viaPenaltyDistance refresh, future-connection segments). Virtual
//! dispatch during the base ctor only ever reaches the solver6 override with
//! isVia falsy, so the flattened order is observably identical.
//!
//! NEARBY_SEGMENT_CLEARANCE — TS truth (differs from an older comment in
//! contract.rs): the dominant path constructs solver 6, whose super() call
//! passes `opts.nearbySegmentClearance ?? (traceThickness ?? 0.15)/2 +
//! (obstacleMargin ?? 0.15)` (SingleHighDensityRouteSolver6…ts:70-75), and M2
//! never passes nearbySegmentClearance (getSingleRouteSolverOpts,
//! IntraNodeSolver.ts:221-265). The base default 0.15 (:180) is therefore
//! DEAD on this path; the effective clearance is
//! `trace_thickness / 2 + obstacle_margin` (0.225 at defaults).
//!
//! Flatbush/R-tree is intentionally NOT ported: every consumer of the
//! spatial queries early-returns on ANY hit, so a linear bbox scan over the
//! SoA arrays is result-identical (PORT-SPEC §6.14; TS_LINEAR_SCAN_MAX is
//! semantics-free). Candidate iteration order (ascending index) matches the
//! TS linear branch.
//!
//! Arena: TS links `Node{x,y,z,g,h,f,parent}` via object pointers; here nodes
//! live in a `Vec<SrNode>` with u32 parent indices (PORT-SPEC §2(c)).
//! Rejected grid/via neighbors are never arena-allocated (TS allocates and
//! drops them) — arena indices are unobservable, so this is semantics-free.
//!
//! Divergences from TS, all flagged in the port report:
//!   (a) The packed-key safety guard (SingleHighDensityRouteSolver.ts:229-243)
//!       THROWS in TS; here it marks the solver Failed with the same message
//!       text (Rust panics would kill the rayon worker). Unreachable for
//!       finite board inputs.
//!   (b) Error-message number formatting uses Rust Display (error text is not
//!       part of the golden acceptance gate — PORT-SPEC §7 compares solved/
//!       iterations/maxIterations/traj/routes).
//!   (c) `solved_path()` emits `root_connection_name: None, region_id: None`
//!       and the interned connection name; M2 overwrites all three identity
//!       fields on receipt (see contract.rs SrInput docs).

use std::collections::HashSet;

use crate::contract::{Bounds, ConnSlice, FutureConn, HdRoute, SrInput, SrStatus};
use crate::geom_rng::{
    distance, do_segments_intersect, is_safe_integer, js_max, js_min, js_round, or_zero,
    point_to_segment_distance,
};

/// Sentinel for "no parent" (`parent: null`).
const NONE_IDX: u32 = u32::MAX;

/// GREEDY_MULTIPLER [sic] — SingleHighDensityRouteSolver.ts:64.
const GREEDY_MULTIPLER: f64 = 1.1;

/// FUTURE_CONNECTION_VIA_TRACE_CLEARANCE — SingleHighDensityRouteSolver6…ts:12
/// (constant: the portfolio never sends this key — PORT-SPEC §3).
const FUTURE_CONNECTION_VIA_TRACE_CLEARANCE: f64 = 0.1;

// ===========================================================================
// SingleRouteCandidatePriorityQueue — verbatim port of
// lib/data-structures/SingleRouteCandidatePriorityQueue.ts (PORT-SPEC §6.5:
// tie behavior is LOAD-BEARING; comparisons and their order are copied
// exactly). `f` is copied into the entry: TS compares `node.f` live, but f is
// assigned before enqueue and never mutated afterwards, so the copy is
// equivalent.
// ===========================================================================

/// Heap element: the f cost plus the arena index of the node.
#[derive(Clone, Copy, Debug)]
pub struct HeapEntry {
    pub f: f64,
    pub idx: u32,
}

pub struct SingleRouteCandidatePriorityQueue {
    heap: Vec<HeapEntry>,
}

impl SingleRouteCandidatePriorityQueue {
    /// constructor(nodes) — :16-22 (enqueues one by one).
    pub fn new(nodes: Vec<HeapEntry>) -> SingleRouteCandidatePriorityQueue {
        let mut q = SingleRouteCandidatePriorityQueue { heap: Vec::new() };
        for node in nodes {
            q.enqueue(node);
        }
        q
    }

    /// :24-26
    fn get_left_child_index(parent_index: usize) -> usize {
        2 * parent_index + 1
    }

    /// :28-30
    fn get_right_child_index(parent_index: usize) -> usize {
        2 * parent_index + 2
    }

    /// :32-34 — `Math.floor((childIndex - 1) / 2)`: -1 for childIndex 0
    /// (floor division, hence div_euclid, NOT Rust's truncating `/`).
    fn get_parent_index(child_index: usize) -> isize {
        ((child_index as isize) - 1).div_euclid(2)
    }

    /// :36-38
    fn has_left_child(&self, index: usize) -> bool {
        Self::get_left_child_index(index) < self.heap.len()
    }

    /// :40-42
    fn has_right_child(&self, index: usize) -> bool {
        Self::get_right_child_index(index) < self.heap.len()
    }

    /// :44-46
    fn has_parent(index: usize) -> bool {
        Self::get_parent_index(index) >= 0
    }

    /// :48-50
    fn left_child(&self, index: usize) -> HeapEntry {
        self.heap[Self::get_left_child_index(index)]
    }

    /// :52-54
    fn right_child(&self, index: usize) -> HeapEntry {
        self.heap[Self::get_right_child_index(index)]
    }

    /// :56-58 (only called when has_parent(index))
    fn parent(&self, index: usize) -> HeapEntry {
        self.heap[Self::get_parent_index(index) as usize]
    }

    /// dequeue() — :69-78. Note the exact TS sequence: heap[0] = heap[last],
    /// pop, heapifyDown (self-assign + pop when len == 1).
    pub fn dequeue(&mut self) -> Option<HeapEntry> {
        if self.heap.is_empty() {
            return None; // :70-72 (null)
        }
        let item = self.heap[0]; // :73
        let last = self.heap[self.heap.len() - 1];
        self.heap[0] = last; // :74
        self.heap.pop(); // :75
        self.heapify_down(); // :76
        Some(item) // :77
    }

    /// peek() — :80-85.
    #[allow(dead_code)]
    pub fn peek(&self) -> Option<HeapEntry> {
        self.heap.first().copied()
    }

    /// enqueue(item) — :87-90.
    pub fn enqueue(&mut self, item: HeapEntry) {
        self.heap.push(item); // :88
        self.heapify_up(); // :89
    }

    /// heapifyUp() — :92-98. STRICT `>` (equal-f nodes do NOT bubble past
    /// each other).
    fn heapify_up(&mut self) {
        let mut index = self.heap.len() - 1; // :93 (called right after a push)
        while Self::has_parent(index) && self.parent(index).f > self.heap[index].f {
            // :94
            let pi = Self::get_parent_index(index) as usize;
            self.heap.swap(pi, index); // :95
            index = pi; // :96
        }
    }

    /// heapifyDown() — :100-117. `rightChild.f < leftChild.f` picks the right
    /// child only when STRICTLY smaller; `heap[index].f < heap[child].f` is
    /// the (strict) break condition — equal f keeps sifting down. Copied
    /// exactly.
    fn heapify_down(&mut self) {
        let mut index: usize = 0; // :101
        while self.has_left_child(index) {
            // :102
            let mut smaller_child_index = Self::get_left_child_index(index); // :103
            if self.has_right_child(index) && self.right_child(index).f < self.left_child(index).f
            {
                // :104-108
                smaller_child_index = Self::get_right_child_index(index);
            }
            if self.heap[index].f < self.heap[smaller_child_index].f {
                break; // :110-111
            } else {
                self.heap.swap(index, smaller_child_index); // :112-113
            }
            index = smaller_child_index; // :115
        }
    }

    /// getTopN(n) — :119-124. JS `.sort((a, b) => a.f - b.f)` is a STABLE
    /// sort (ES2019) whose comparator maps NaN to +0 (equal); mirrored with a
    /// stable sort_by and the same three-way mapping. Unused by M1 itself;
    /// kept because the spec says port the file verbatim.
    #[allow(dead_code)]
    pub fn get_top_n(&self, n: usize) -> Vec<HeapEntry> {
        let mut copy = self.heap.clone();
        copy.sort_by(|a, b| {
            let d = a.f - b.f;
            if d < 0.0 {
                std::cmp::Ordering::Less
            } else if d > 0.0 {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        });
        copy.truncate(n);
        copy
    }
}

// ===========================================================================
// Arena node + internal obstacle storage
// ===========================================================================

/// TS `Node` (SingleRouteCandidatePriorityQueue.ts:1-11) — arena form with a
/// u32 parent index (NONE_IDX == null).
#[derive(Clone, Copy, Debug)]
struct SrNode {
    x: f64,
    y: f64,
    z: f64,
    g: f64,
    /// Kept for TS field parity/debugging; the live h/f travel in HeapEntry.
    #[allow(dead_code)]
    h: f64,
    #[allow(dead_code)]
    f: f64,
    parent: u32,
}

/// IndexedObstacleSegment (SingleHighDensityRouteSolver.ts:1099-1104); A/B z
/// components are never read (only the shared segment z), so endpoints are
/// stored as x/y.
struct ObstacleSegment {
    z: f64,
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    connected_to_current_connection: bool,
}

/// futureConnectionSegments element (SingleHighDensityRouteSolver6…ts:38-42).
/// `connectionName` and point z's are dropped: the only consumer
/// (isViaTooCloseToFutureConnectionTrace, :175-205) reads x/y only.
struct FutureSegment {
    sx: f64,
    sy: f64,
    ex: f64,
    ey: f64,
}

/// Result of buildObstacleIndexes (:535-630), linear branch only: segment
/// list + via list + SoA bbox arrays (:567-629).
struct ObstacleData {
    segments: Vec<ObstacleSegment>,
    vias: Vec<[f64; 2]>,
    seg_box_min_x: Vec<f64>,
    seg_box_min_y: Vec<f64>,
    seg_box_max_x: Vec<f64>,
    seg_box_max_y: Vec<f64>,
    via_x: Vec<f64>,
    via_y: Vec<f64>,
}

/// buildObstacleIndexes (:535-630) + getSameLayerPointPairs (:1108-1126),
/// Flatbush branches dropped (§6.14). The TS empty-routes early return
/// (:536-540) leaves every array empty — identical to the loop not running.
fn build_obstacle_data(conn: u32, conn_slice: &ConnSlice, obstacle_routes: &[HdRoute]) -> ObstacleData {
    let mut segments: Vec<ObstacleSegment> = Vec::new();
    let mut vias: Vec<[f64; 2]> = Vec::new();

    for route in obstacle_routes {
        // :545-550 — `this.connMap?.areIdsConnected?.(this.connectionName,
        // route.connectionName) ?? false`. conn_slice is always present on
        // the dominant path; a route name that was never interned cannot
        // satisfy any clause (see contract::ConnSlice docs), so a lookup
        // miss is `false`.
        let connected_to_current_connection = match conn_slice.lookup(&route.connection_name) {
            Some(route_conn) => conn_slice.are_ids_connected(conn, route_conn),
            None => false,
        };

        // getSameLayerPointPairs (:1108-1126): consecutive same-z pairs.
        if route.route.len() > 1 {
            for i in 0..route.route.len() - 1 {
                let p0 = route.route[i];
                let p1 = route.route[i + 1];
                if p0[2] == p1[2] {
                    segments.push(ObstacleSegment {
                        z: p0[2],
                        ax: p0[0],
                        ay: p0[1],
                        bx: p1[0],
                        by: p1[1],
                        connected_to_current_connection,
                    });
                }
            }
        }

        for via in &route.vias {
            vias.push(*via); // :559-561
        }
    }

    // :567-598 (linear branch) — per-segment bboxes via Math.min/Math.max.
    let seg_count = segments.len();
    let mut seg_box_min_x = Vec::with_capacity(seg_count);
    let mut seg_box_min_y = Vec::with_capacity(seg_count);
    let mut seg_box_max_x = Vec::with_capacity(seg_count);
    let mut seg_box_max_y = Vec::with_capacity(seg_count);
    for segment in &segments {
        seg_box_min_x.push(js_min(segment.ax, segment.bx)); // :580
        seg_box_min_y.push(js_min(segment.ay, segment.by)); // :581
        seg_box_max_x.push(js_max(segment.ax, segment.bx)); // :582
        seg_box_max_y.push(js_max(segment.ay, segment.by)); // :583
    }

    // :607-629 (linear branch) — via coordinate arrays.
    let via_x: Vec<f64> = vias.iter().map(|v| v[0]).collect();
    let via_y: Vec<f64> = vias.iter().map(|v| v[1]).collect();

    ObstacleData {
        segments,
        vias,
        seg_box_min_x,
        seg_box_min_y,
        seg_box_max_x,
        seg_box_max_y,
        via_x,
        via_y,
    }
}

/// getFutureConnectionSegments (SingleHighDensityRouteSolver6…ts:127-173).
/// Segments run from the FIRST point to each subsequent point (`const [start,
/// ...rest]` — a star, not a polyline), skipping connections that are
/// name-equal or net-connected to the current one (an inlined mirror of the
/// asymmetric areIdsConnected — :139-151) and zero-length segments (:158-163).
fn get_future_connection_segments(
    conn: u32,
    future_connections: &[FutureConn],
    conn_slice: &ConnSlice,
) -> Vec<FutureSegment> {
    let mut segments: Vec<FutureSegment> = Vec::new();

    // :141 — hoisted: this.connectionName's net is loop-invariant.
    // JS truthiness of `connectionNetId` maps to Some(_): an interned net id
    // cannot be the falsy "" (see contract::ConnSlice docs).
    let connection_net_id = conn_slice.get_net_connected_to_id(conn);

    for future_connection in future_connections {
        let future_connection_name = future_connection.conn; // :144
        let mut is_connected = future_connection_name == conn; // :145
        if !is_connected && connection_net_id.is_some() {
            // :146-151
            let future_net_id = conn_slice.get_net_connected_to_id(future_connection_name);
            is_connected = future_net_id.is_some()
                && (connection_net_id == future_net_id || future_net_id == Some(conn));
        }
        if is_connected {
            continue; // :152
        }

        // :154-155  const [start, ...rest] = futureConnection.points
        let Some((start, rest)) = future_connection.points.split_first() else {
            continue;
        };

        for end in rest {
            // :157-163
            if (start[0] - end[0]).abs() < 1e-9 && (start[1] - end[1]).abs() < 1e-9 {
                continue;
            }
            segments.push(FutureSegment {
                sx: start[0],
                sy: start[1],
                ex: end[0],
                ey: end[1],
            }); // :164-168
        }
    }

    segments
}

/// clamp (SingleHighDensityRouteSolver.ts:1128-1130):
/// `Math.max(min, Math.min(value, max))`.
#[inline]
fn js_clamp(value: f64, min: f64, max: f64) -> f64 {
    js_max(min, js_min(value, max))
}

/// getSegmentToSegmentCenterlineDistance (:1132-1144): min of the four
/// point-to-segment distances, folded left in TS argument order.
#[allow(clippy::too_many_arguments)]
#[inline]
fn get_segment_to_segment_centerline_distance(
    left_ax: f64,
    left_ay: f64,
    left_bx: f64,
    left_by: f64,
    right_ax: f64,
    right_ay: f64,
    right_bx: f64,
    right_by: f64,
) -> f64 {
    js_min(
        js_min(
            js_min(
                point_to_segment_distance(left_ax, left_ay, right_ax, right_ay, right_bx, right_by),
                point_to_segment_distance(left_bx, left_by, right_ax, right_ay, right_bx, right_by),
            ),
            point_to_segment_distance(right_ax, right_ay, left_ax, left_ay, left_bx, left_by),
        ),
        point_to_segment_distance(right_bx, right_by, left_ax, left_ay, left_bx, left_by),
    )
}

// ===========================================================================
// SrSolver — contract C1
// ===========================================================================

/// The flattened SingleHighDensityRouteSolver +
/// SingleHighDensityRouteSolver6_VertHorzLayer_FutureCost instance.
/// All input is copied/derived at construction — no borrows survive `new`
/// (contract.rs SrInput docs), so SrSolver is Send.
pub struct SrSolver {
    // ---- BaseSolver state (BaseSolver.ts:10-15) ----
    /// = 10_000 (SingleHighDensityRouteSolver.ts:181, `10e3`)
    max_iterations: u64,
    solved: bool,
    failed: bool,
    iterations: u64,
    /// NaN after every step() — the load-bearing B2 pipeline (§6.3).
    progress: f64,
    error: Option<String>,

    // ---- SingleHighDensityRouteSolver fields (:49-129) ----
    bounds: Bounds,
    bounds_size_w: f64,
    /// Kept for TS field parity (boundsSize, :155-158); only read in the ctor.
    #[allow(dead_code)]
    bounds_size_h: f64,
    bounds_center_x: f64,
    bounds_center_y: f64,
    a: [f64; 3],
    b: [f64; 3],
    straight_line_distance: f64,
    via_diameter: f64,
    trace_thickness: f64,
    obstacle_margin: f64,
    /// deduped + ascending (ctor :173-176)
    available_z: Vec<f64>,
    cell_step: f64,
    /// 0.3 until the solver6 ctor tail recomputes it (SHDRS6:85-86)
    via_penalty_factor: f64,
    nearby_segment_clearance: f64,
    /// cellStep + straightLineDistance * VIA_PENALTY_FACTOR (:344-347)
    via_penalty_distance: f64,
    explored_nodes: HashSet<i64>,
    node_key_ix_min: f64,
    node_key_iy_min: f64,
    node_key_z_min: f64,
    node_key_iy_extent: f64,
    node_key_z_extent: f64,
    candidates: SingleRouteCandidatePriorityQueue,
    connection_name: String,
    solved_path: Option<HdRoute>,
    /// owned copy of the input slice (order preserved)
    future_connections: Vec<FutureConn>,
    obstacle_segments: Vec<ObstacleSegment>,
    obstacle_vias: Vec<[f64; 2]>,
    seg_box_min_x: Vec<f64>,
    seg_box_min_y: Vec<f64>,
    seg_box_max_x: Vec<f64>,
    seg_box_max_y: Vec<f64>,
    via_x: Vec<f64>,
    via_y: Vec<f64>,

    // ---- Solver6 fields (SHDRS6:6-11, :38-65) ----
    fut_trace_pen: f64,
    fut_via_pen: f64,
    fut_prox_vd: f64,
    misaligned_pen: f64,
    flip_trace: bool,
    future_connection_segments: Vec<FutureSegment>,
    /// [min_x, min_y, max_x, max_y] per segment (SHDRS6:91-98)
    future_connection_segment_bboxes: Vec<[f64; 4]>,

    // ---- Arena (PORT-SPEC §2(c)) ----
    nodes: Vec<SrNode>,
}

impl SrSolver {
    /// Constructors, in exact TS order: base ctor
    /// (SingleHighDensityRouteSolver.ts:131-308) then the solver6 ctor tail
    /// (SingleHighDensityRouteSolver6…ts:67-99). May solve (simple case) or
    /// fail (packed-key guard) before the first step.
    pub fn new(input: SrInput) -> SrSolver {
        // SHDRS6:70-75 — super() opts: nearbySegmentClearance ??
        // traceThickness/2 + obstacleMargin (M2 never passes the override;
        // all scalars arrive resolved). See module docs.
        let nearby_segment_clearance = input.trace_thickness / 2.0 + input.obstacle_margin;

        // Base ctor :151-154. CELL_SIZE_FACTOR `?? 1` is resolved in Hp.
        let bounds = input.bounds;
        let cell_size_factor = input.hp.cell_size_factor;

        // :155-162
        let bounds_size_w = bounds.max_x - bounds.min_x;
        let bounds_size_h = bounds.max_y - bounds.min_y;
        let bounds_center_x = (bounds.min_x + bounds.max_x) / 2.0;
        let bounds_center_y = (bounds.min_y + bounds.max_y) / 2.0;

        // :163-172 (viaDiameter/traceThickness/obstacleMargin/layerCount
        // defaults are the marshaling side's job — contract.rs)
        let a = input.a;
        let b = input.b;
        let via_diameter = input.via_diameter;
        let trace_thickness = input.trace_thickness;
        let obstacle_margin = input.obstacle_margin;
        let layer_count = input.layer_count;

        // :173-176 — `[...new Set(availableZ)].sort((a, b) => a - b)` or
        // 0..layerCount. Set dedupe keeps first occurrence (SameValueZero;
        // z is never NaN); the numeric-comparator sort is ascending.
        let available_z: Vec<f64> = if !input.available_z.is_empty() {
            let mut dedup: Vec<f64> = Vec::new();
            for &z in input.available_z {
                if !dedup.iter().any(|&d| d == z) {
                    dedup.push(z);
                }
            }
            dedup.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
            dedup
        } else {
            (0..layer_count).map(|i| i as f64).collect()
        };

        // :178
        let straight_line_distance = distance(a[0], a[1], b[0], b[1]);
        // :186
        let num_routes = input.obstacle_routes.len() + input.future_connections.len();
        // :187 (linear-scan form)
        let obs = build_obstacle_data(input.conn, input.conn_slice, input.obstacle_routes);

        // :188-199 — cell sizing loop. `bestRowOrColumnCount ** 2` on a small
        // exact integer is fl-identical to the product (see geom_rng docs).
        let best_row_or_column_count = (5.0 * (num_routes as f64 + 1.0)).ceil(); // :188
        let brc_sq = best_row_or_column_count * best_row_or_column_count;
        let mut cell_step: f64 = 0.05; // :63
        let mut num_x_cells = bounds_size_w / cell_step; // :189
        let mut num_y_cells = bounds_size_h / cell_step; // :190
        while num_x_cells * num_y_cells > brc_sq {
            // :192
            if cell_step * 2.0 > input.min_dist_between_entering_points {
                break; // :193-195
            }
            cell_step *= 2.0; // :196
            num_x_cells = bounds_size_w / cell_step; // :197
            num_y_cells = bounds_size_h / cell_step; // :198
        }
        cell_step *= cell_size_factor; // :201

        // :207-228 — packed-key ranges (js_round == Math.round, §6.7;
        // Math.min/Math.max folded in TS argument order).
        let start_z_for_key = a[2]; // :208  A.z ?? 0 (z always present)
        let key_ix_lo = js_round(js_min(bounds.min_x, a[0]) / cell_step) - 2.0; // :209-210
        let key_ix_hi = js_round(js_max(bounds.max_x, a[0]) / cell_step) + 2.0; // :211-212
        let key_iy_lo = js_round(js_min(bounds.min_y, a[1]) / cell_step) - 2.0; // :213-214
        let key_iy_hi = js_round(js_max(bounds.max_y, a[1]) / cell_step) + 2.0; // :215-216
        let mut key_z_lo = js_min(js_min(0.0, start_z_for_key), b[2]); // :217
        for &z in &available_z {
            key_z_lo = js_min(key_z_lo, z);
        }
        let mut key_z_hi = js_max(js_max(start_z_for_key, b[2]), layer_count as f64 - 1.0); // :218-223
        for &z in &available_z {
            key_z_hi = js_max(key_z_hi, z);
        }
        let node_key_iy_extent = key_iy_hi - key_iy_lo + 1.0; // :227
        let node_key_z_extent = key_z_hi - key_z_lo + 1.0; // :228
        let node_key_capacity = (key_ix_hi - key_ix_lo + 1.0) * node_key_iy_extent * node_key_z_extent; // :229-230

        // :231-243 — safety guard. `!(cap <= MAX_SAFE_INTEGER)` is NaN-safe;
        // mirrored as `cap <= MAX` on the ok side.
        let key_space_ok = is_safe_integer(key_ix_lo)
            && is_safe_integer(key_ix_hi)
            && is_safe_integer(key_iy_lo)
            && is_safe_integer(key_iy_hi)
            && key_z_lo.is_finite()
            && key_z_hi.is_finite()
            && node_key_capacity <= 9007199254740991.0;

        let connection_name = input.conn_slice.resolve(input.conn).to_string();

        let mut s = SrSolver {
            max_iterations: 10_000, // :181  MAX_ITERATIONS = 10e3
            solved: false,
            failed: false,
            iterations: 0,
            progress: 0.0,
            error: None,
            bounds,
            bounds_size_w,
            bounds_size_h,
            bounds_center_x,
            bounds_center_y,
            a,
            b,
            straight_line_distance,
            via_diameter,
            trace_thickness,
            obstacle_margin,
            available_z,
            cell_step,
            via_penalty_factor: 0.3, // :67 base default (recomputed below)
            nearby_segment_clearance,
            via_penalty_distance: 0.0, // set by update_via_penalty_distance
            explored_nodes: HashSet::new(), // :177
            node_key_ix_min: key_ix_lo, // :224
            node_key_iy_min: key_iy_lo, // :225
            node_key_z_min: key_z_lo,   // :226
            node_key_iy_extent,
            node_key_z_extent,
            candidates: SingleRouteCandidatePriorityQueue::new(Vec::new()),
            connection_name,
            solved_path: None,
            future_connections: input.future_connections.to_vec(), // :179 (owned)
            obstacle_segments: obs.segments,
            obstacle_vias: obs.vias,
            seg_box_min_x: obs.seg_box_min_x,
            seg_box_min_y: obs.seg_box_min_y,
            seg_box_max_x: obs.seg_box_max_x,
            seg_box_max_y: obs.seg_box_max_y,
            via_x: obs.via_x,
            via_y: obs.via_y,
            fut_trace_pen: input.hp.fut_trace_pen, // SHDRS6:6, :76-79
            fut_via_pen: input.hp.fut_via_pen,     // SHDRS6:7
            fut_prox_vd: input.hp.fut_prox_vd,     // SHDRS6:8
            misaligned_pen: input.hp.misaligned_pen, // SHDRS6:9
            flip_trace: input.hp.flip_trace,       // SHDRS6:11
            future_connection_segments: Vec::new(),
            future_connection_segment_bboxes: Vec::new(),
            nodes: Vec::new(),
        };

        if !key_space_ok {
            // TS THROWS here (:240-242); Rust marks Failed with the same text
            // (divergence (a) in the module docs). Nothing below runs in TS
            // after the throw, so return immediately.
            s.failed = true;
            s.error = Some(format!(
                "SingleHighDensityRouteSolver: packed node key space does not fit in a safe integer (bounds {{\"minX\":{},\"maxX\":{},\"minY\":{},\"maxY\":{}}}, cellStep {}, z range [{}, {}])",
                bounds.min_x, bounds.max_x, bounds.min_y, bounds.max_y, cell_step, key_z_lo, key_z_hi
            ));
            return s;
        }

        s.update_via_penalty_distance(); // :245 (with VIA_PENALTY_FACTOR = 0.3)

        // :247-255
        let is_on_same_edge = ((s.a[0] - s.bounds.min_x).abs() < 0.001
            && (s.b[0] - s.bounds.min_x).abs() < 0.001) // both on left
            || ((s.a[0] - s.bounds.max_x).abs() < 0.001
                && (s.b[0] - s.bounds.max_x).abs() < 0.001) // both on right
            || ((s.a[1] - s.bounds.min_y).abs() < 0.001
                && (s.b[1] - s.bounds.min_y).abs() < 0.001) // both on bottom
            || ((s.a[1] - s.bounds.max_y).abs() < 0.001
                && (s.b[1] - s.bounds.max_y).abs() < 0.001); // both on top

        // :257-264 (`this.futureConnections &&` is always truthy — `?? []`)
        if s.future_connections.is_empty() && input.obstacle_routes.is_empty() && !is_on_same_edge
        {
            s.handle_simple_cases();
        }

        // :266-269 — initial node snapped to the HALF grid.
        let half_step = s.cell_step / 2.0;
        let init_x = js_round(s.a[0] / half_step) * half_step;
        let init_y = js_round(s.a[1] / half_step) * half_step;
        // :270-277 initialNodeGridOffset is visualize-only — not ported.

        // :278-295 — arena: [0] = initialParent (exact A), [1] = rounded.
        s.nodes.push(SrNode {
            x: s.a[0],
            y: s.a[1],
            z: s.a[2], // A.z ?? 0
            g: 0.0,
            h: 0.0,
            f: 0.0,
            parent: NONE_IDX,
        });
        s.nodes.push(SrNode {
            x: init_x,
            y: init_y,
            z: s.a[2],
            g: 0.0,
            h: 0.0,
            f: 0.0,
            parent: 0,
        });

        // :296-303
        let rounded_differs_from_a =
            (init_x - s.a[0]).abs() > 1e-9 || (init_y - s.a[1]).abs() > 1e-9;
        let should_fallback_to_exact_start = rounded_differs_from_a
            && (s.is_node_too_close_to_obstacle(init_x, init_y, s.a[2], 0, None, false)
                || s.is_node_too_close_to_edge(init_x, init_y, false)
                || s.does_path_to_parent_intersect_obstacle(init_x, init_y, s.a[2], 0));

        // :305-307 — queue seeded with exactly one node, f = 0.
        let start_idx: u32 = if should_fallback_to_exact_start { 0 } else { 1 };
        s.candidates.enqueue(HeapEntry { f: 0.0, idx: start_idx });

        // ---- Solver6 ctor tail (SHDRS6:81-98) ----
        let vias_that_can_fit_horz = s.bounds_size_w / s.via_diameter; // :82
        let route_count = js_max(1.0, num_routes as f64); // :84  Math.max(1, numRoutes)
        s.via_penalty_factor = 0.3 * (vias_that_can_fit_horz / route_count) * input.hp.via_pen2; // :85-86
        s.update_via_penalty_distance(); // :89
        s.future_connection_segments =
            get_future_connection_segments(input.conn, &s.future_connections, input.conn_slice); // :90
        s.future_connection_segment_bboxes = s
            .future_connection_segments
            .iter()
            .map(|segment| {
                [
                    js_min(segment.sx, segment.ex), // :93  Math.min(start.x, end.x)
                    js_min(segment.sy, segment.ey), // :94
                    js_max(segment.sx, segment.ex), // :95
                    js_max(segment.sy, segment.ey), // :96
                ]
            })
            .collect(); // :91-98

        s
    }

    // ---- Contract C1 surface -------------------------------------------

    /// BaseSolver.step (BaseSolver.ts:33-56) — full semantics; DO NOT
    /// reorder (§6.4: iterations++ BEFORE _step; budget check
    /// `iterations > MAX_ITERATIONS` AFTER; solved/failed short-circuit).
    pub fn step(&mut self) {
        if self.solved {
            return; // :34
        }
        if self.failed {
            return; // :35
        }
        self.iterations += 1; // :36
        self._step(); // :38 (try/catch dropped — no throwing paths in the port)
        // :45-47 — tryFinalAcceptance() is the BaseSolver no-op (:87) here.
        if !self.solved && self.iterations > self.max_iterations {
            // :48-51 — note this runs at iterations == 10_001: the TS budget
            // is off-by-one-inclusive and _step DID execute this iteration.
            self.error = Some(format!(
                "SingleHighDensityRouteSolver ran out of iterations (MAX_ITERATIONS={})",
                self.max_iterations
            )); // getSolverName() override: SingleHighDensityRouteSolver.ts:45-47
            self.failed = true;
        }
        // :52-55 — zero-arg computeProgress() recompute: undefined goalDist
        // + falsy isOnLayer drives the NaN pipeline (§6.3, the B2 finding).
        // NaN + viaPenaltyDistance == the TS `undefined + number`.
        self.progress = self.compute_progress_with(f64::NAN, false);
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

    pub fn iterations(&self) -> u64 {
        self.iterations
    }

    /// MAX_ITERATIONS = 10_000 (SingleHighDensityRouteSolver.ts:181).
    pub fn max_iterations(&self) -> u64 {
        self.max_iterations
    }

    /// Raw observable progress — NaN after every step() (§6.3). M2 applies
    /// `|| 0` (geom_rng::or_zero) exactly as IntraNodeSolver.ts:214-219 does.
    pub fn progress(&self) -> f64 {
        self.progress
    }

    /// The solved route, if any. Identity fields: `connection_name` is the
    /// resolved input name; `root_connection_name`/`region_id` are None — M2
    /// overwrites all three on receipt (contract.rs SrInput docs).
    pub fn solved_path(&self) -> Option<HdRoute> {
        self.solved_path.clone()
    }

    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    /// isEndpointViaSafe (IntraNodeSolver.ts:592-631), evaluated for THIS
    /// solver's A/B: viaNode = {x: A.x, y: A.y, z: A.z, parent: {A, parent:
    /// null}} (:598-614; viaPoint == A's coordinates, :275). The via
    /// parent-chain walk (SingleHighDensityRouteSolver.ts:352-369) inspects
    /// only ancestors that themselves have parents, so the single-node chain
    /// contributes nothing — parent NONE_IDX is exact.
    /// Returns true when the endpoint via is SAFE (TS helper's sense).
    pub fn is_endpoint_via_safe(&self) -> bool {
        let margin = self.via_diameter / 2.0 + self.obstacle_margin / 2.0; // :619
        if self.is_node_too_close_to_obstacle(self.a[0], self.a[1], self.a[2], NONE_IDX, Some(margin), true) {
            return false; // :616-624
        }
        if self.is_node_too_close_to_edge(self.a[0], self.a[1], true) {
            return false; // :626-628
        }
        true // :630
    }

    // ---- The A* pop-expand (SingleHighDensityRouteSolver.ts:866-922) ----

    fn _step(&mut self) {
        // :867-880 — dequeue until an unexplored node surfaces. Packed keys
        // can legitimately be 0: the found/None distinction is on the NODE.
        let mut found: Option<(u32, i64)> = None;
        while let Some(entry) = self.candidates.dequeue() {
            let n = self.nodes[entry.idx as usize];
            let key = self.get_packed_node_key(n.x, n.y, n.z); // :873-877
            if !self.explored_nodes.contains(&key) {
                found = Some((entry.idx, key)); // :878
                break;
            }
        }

        let Some((cur_idx, cur_key)) = found else {
            // :882-886
            self.failed = true;
            self.error = Some("Ran out of candidate nodes to explore".to_string());
            return;
        };
        self.explored_nodes.insert(cur_key); // :887
        // (:888-890 debug bookkeeping not ported)

        let cur = self.nodes[cur_idx as usize];
        let goal_dist = distance(cur.x, cur.y, self.b[0], self.b[1]); // :892

        // :894-898
        self.progress = self.compute_progress_with(goal_dist, cur.z == self.b[2]);

        // :900-916 — goal test. The last-segment check runs against a
        // synthetic node {B.x, B.y, z: cur.z, parent: cur}.
        if goal_dist <= self.cell_step * std::f64::consts::SQRT_2
            && cur.z == self.b[2]
            && !self.does_path_to_parent_intersect_obstacle(self.b[0], self.b[1], cur.z, cur_idx)
        {
            self.solved = true; // :914
            self.set_solved_path(cur_idx); // :915
        }

        // :918-921 — neighbors are expanded and enqueued EVEN when the goal
        // test just solved (TS has no early return here).
        let neighbors = self.get_neighbors(cur_idx);
        for neighbor in neighbors {
            self.candidates.enqueue(neighbor);
        }
    }

    /// getNeighbors (:708-801). Emission order is LOAD-BEARING (§6.5):
    /// dx -1..1 outer, dy -1..1 inner (skipping 0,0), then via neighbors in
    /// availableZ ascending order.
    fn get_neighbors(&mut self, cur_idx: u32) -> Vec<HeapEntry> {
        let cur = self.nodes[cur_idx as usize];
        let mut neighbors: Vec<HeapEntry> = Vec::new();
        let Bounds {
            min_x,
            max_x,
            min_y,
            max_y,
        } = self.bounds; // :711

        for dx in -1i32..=1 {
            for dy in -1i32..=1 {
                if dx == 0 && dy == 0 {
                    continue; // :715
                }
                let x = js_clamp(cur.x + (dx as f64) * self.cell_step, min_x, max_x); // :717
                let y = js_clamp(cur.y + (dy as f64) * self.cell_step, min_y, max_y); // :718
                let neighbor_key = self.get_packed_node_key(x, y, cur.z); // :719

                if self.explored_nodes.contains(&neighbor_key) {
                    continue; // :721-723
                }

                // :725-733 — neighbor node (parent = cur); arena allocation
                // is deferred until the predicates accept it.
                if self.is_node_too_close_to_obstacle(x, y, cur.z, cur_idx, None, false) {
                    // :735-741
                    self.explored_nodes.insert(neighbor_key);
                    continue;
                }

                if self.is_node_too_close_to_edge(x, y, false) {
                    // :743-746
                    self.explored_nodes.insert(neighbor_key);
                    continue;
                }

                if self.does_path_to_parent_intersect_obstacle(x, y, cur.z, cur_idx) {
                    // :748-756
                    self.explored_nodes.insert(neighbor_key);
                    continue;
                }

                // :758-760 — computeG then computeH share the per-node memo
                // (SHDRS6 ensureSharedNodeCosts :236-246): goalDist and the
                // future-connection penalty are computed ONCE per node.
                let (shared_goal_dist, shared_penalty) =
                    self.compute_shared_node_costs(x, y, cur.z, cur_idx);
                let g = self.compute_g(x, y, cur.z, cur_idx, shared_penalty);
                let h = self.compute_h(cur.z, shared_goal_dist, shared_penalty);
                let f = self.compute_f(g, h);
                let idx = self.push_node(x, y, cur.z, g, h, f, cur_idx);
                neighbors.push(HeapEntry { f, idx }); // :762
            }
        }

        // :766-798 — via neighbors for all other layers, availableZ ascending.
        for zi in 0..self.available_z.len() {
            let new_z = self.available_z[zi];
            if new_z == cur.z {
                continue; // :768
            }

            if self
                .explored_nodes
                .contains(&self.get_packed_node_key(cur.x, cur.y, new_z))
            {
                continue; // :770-772
            }

            // :774-782 viaNeighbor (parent = cur)
            let margin = self.via_diameter / 2.0 + self.obstacle_margin / 2.0; // :786-787
            if !self.is_node_too_close_to_obstacle(cur.x, cur.y, new_z, cur_idx, Some(margin), true)
                && !self.is_node_too_close_to_edge(cur.x, cur.y, true)
            {
                // :784-797 — NOTE: rejected via neighbors are NOT added to
                // exploredNodes (unlike rejected grid neighbors).
                let (shared_goal_dist, shared_penalty) =
                    self.compute_shared_node_costs(cur.x, cur.y, new_z, cur_idx);
                let g = self.compute_g(cur.x, cur.y, new_z, cur_idx, shared_penalty);
                let h = self.compute_h(new_z, shared_goal_dist, shared_penalty);
                let f = self.compute_f(g, h);
                let idx = self.push_node(cur.x, cur.y, new_z, g, h, f, cur_idx);
                neighbors.push(HeapEntry { f, idx }); // :796
            }
        }

        neighbors // :800
    }

    fn push_node(&mut self, x: f64, y: f64, z: f64, g: f64, h: f64, f: f64, parent: u32) -> u32 {
        let idx = self.nodes.len() as u32;
        self.nodes.push(SrNode {
            x,
            y,
            z,
            g,
            h,
            f,
            parent,
        });
        idx
    }

    // ---- Keys, costs, progress -----------------------------------------

    /// getPackedNodeKey (:698-706) — the exact TS f64 expression, cast to i64
    /// for the HashSet. The ctor guard proves the packed value is an exact
    /// non-negative integer <= 2^53-1, so f64 arithmetic is exact and the
    /// cast is lossless.
    fn get_packed_node_key(&self, x: f64, y: f64, z: f64) -> i64 {
        let packed = ((js_round(x / self.cell_step) - self.node_key_ix_min)
            * self.node_key_iy_extent
            + (js_round(y / self.cell_step) - self.node_key_iy_min))
            * self.node_key_z_extent
            + (z - self.node_key_z_min);
        packed as i64
    }

    /// updateViaPenaltyDistance (:344-347).
    fn update_via_penalty_distance(&mut self) {
        self.via_penalty_distance =
            self.cell_step + self.straight_line_distance * self.via_penalty_factor;
    }

    /// computeF (:685-687): g + h * GREEDY_MULTIPLER.
    fn compute_f(&self, g: f64, h: f64) -> f64 {
        g + h * GREEDY_MULTIPLER
    }

    /// ensureSharedNodeCosts (SHDRS6:236-246): goalDist = distance(node, B)
    /// (:238); penalty = getFutureConnectionPenalty(node, node.z !==
    /// node.parent.z, goalDist) (:241-245). The TS single-entry identity memo
    /// exists only to dedupe the back-to-back computeG/computeH calls on the
    /// same freshly created node — computing the pair once per neighbor is
    /// value-identical.
    fn compute_shared_node_costs(&self, x: f64, y: f64, z: f64, parent_idx: u32) -> (f64, f64) {
        let goal_dist = distance(x, y, self.b[0], self.b[1]); // :238
        let parent_z = self.nodes[parent_idx as usize].z;
        let is_via = z != parent_z; // :243  node.z !== node.parent?.z
        let penalty = self.get_future_connection_penalty(x, y, z, is_via, goal_dist);
        (goal_dist, penalty)
    }

    /// getClosestFutureConnectionPoint (SHDRS6:101-125), including the exact
    /// early rejects (z-penalty / |dx| / |dy| lower bounds — exact, comment
    /// :108-110). Iterates ALL futureConnections (the connected-filter
    /// applies only to segments, not to this penalty scan).
    fn get_closest_future_connection_point(&self, x: f64, y: f64, z: f64) -> Option<[f64; 3]> {
        let mut min_dist = f64::INFINITY; // :102
        let mut closest_point: Option<[f64; 3]> = None; // :103

        for future_connection in &self.future_connections {
            for point in &future_connection.points {
                let z_penalty = if z != point[2] {
                    self.via_penalty_distance
                } else {
                    0.0
                }; // :110
                if z_penalty >= min_dist {
                    continue; // :111
                }
                let dx = (x - point[0]).abs(); // :112
                if dx >= min_dist {
                    continue; // :113
                }
                let dy = (y - point[1]).abs(); // :114
                if dy >= min_dist {
                    continue; // :115
                }
                let dist = distance(x, y, point[0], point[1]) + z_penalty; // :116
                if dist < min_dist {
                    // :117-120
                    min_dist = dist;
                    closest_point = Some(*point);
                }
            }
        }

        closest_point // :124
    }

    /// getFutureConnectionPenalty (SHDRS6:248-268).
    fn get_future_connection_penalty(
        &self,
        x: f64,
        y: f64,
        z: f64,
        is_via: bool,
        goal_dist: f64,
    ) -> f64 {
        let mut future_connection_penalty = 0.0; // :253
        if let Some(closest_future_point) = self.get_closest_future_connection_point(x, y, z) {
            // :254-266
            let dist_to_future_point =
                distance(x, y, closest_future_point[0], closest_future_point[1]); // :256
            if goal_dist <= dist_to_future_point {
                return 0.0; // :257
            }
            let max_dist = self.via_diameter * self.fut_prox_vd; // :258
            let dist_ratio = dist_to_future_point / max_dist; // :259
            let max_penalty = if is_via {
                self.straight_line_distance * self.fut_via_pen // :260-262
            } else {
                self.straight_line_distance * self.fut_trace_pen // :263-264
            };
            future_connection_penalty = max_penalty * (-dist_ratio * 5.0).exp(); // :265  Math.exp (§6.8)
        }
        future_connection_penalty // :267
    }

    /// computeH — SHDRS6:270-279 (the override; the base :669-675 is never
    /// dispatched). `** 1.6` -> powf (glibc pow — §6.8: bit-parity expected
    /// on this box, verified by the golden capture).
    fn compute_h(&self, z: f64, shared_goal_dist: f64, shared_penalty: f64) -> f64 {
        let goal_dist = shared_goal_dist.powf(1.6); // :272
        let base_cost = goal_dist
            + (if z != self.b[2] {
                self.via_penalty_distance
            } else {
                0.0
            }); // :275-276
        base_cost + shared_penalty // :278
    }

    /// computeG — SHDRS6:281-305 (the override; base :677-683 never
    /// dispatched). Parent always exists for cost-bearing nodes.
    fn compute_g(&self, x: f64, y: f64, z: f64, parent_idx: u32, shared_penalty: f64) -> f64 {
        let parent = self.nodes[parent_idx as usize];
        let dx = (x - parent.x).abs(); // :282
        let dy = (y - parent.y).abs(); // :283
        let dist = (dx * dx + dy * dy).sqrt(); // :284  sqrt(dx**2 + dy**2), fl-identical

        // :287 — even layers prefer horizontal, odd vertical. JS `%` on f64
        // == Rust f64 `%` (sign of dividend; z is a small non-negative int).
        let is_even_layer = z % 2.0 == 0.0;
        let misaligned_dist = if !self.flip_trace {
            if is_even_layer {
                dy
            } else {
                dx
            }
        } else if is_even_layer {
            dx
        } else {
            dy
        }; // :288-294

        // :297-301 — left-associated sum, exactly as written.
        let base_cost = parent.g // (node.parent?.g ?? 0)
            + (if z == parent.z {
                0.0
            } else {
                self.via_penalty_distance
            })
            + dist
            + misaligned_dist * self.misaligned_pen;

        base_cost + shared_penalty // :303-304
    }

    /// computeProgress (:847-864). The TS `currentNode` parameter is unused
    /// by the body and omitted here. `this.progress || 0` is or_zero (the
    /// previous step's NaN reads as 0); `Math.max(_, NaN)` poisons to NaN
    /// when called through the zero-arg BaseSolver recompute path.
    fn compute_progress_with(&self, goal_dist: f64, is_on_layer: bool) -> f64 {
        let mut goal_dist = goal_dist;
        if !is_on_layer {
            goal_dist += self.via_penalty_distance; // :848
        }
        let goal_dist_percent = 1.0 - goal_dist / self.straight_line_distance; // :849
        // :855-863 — atan linearization (0.112); atan feeds the schedule
        // trajectories (§6.8).
        js_max(
            or_zero(self.progress), // :856  this.progress || 0
            (2.0 / std::f64::consts::PI)
                * ((0.112 * goal_dist_percent) / (1.0 - goal_dist_percent)).atan(), // :861-862
        )
    }

    // ---- Obstacle predicates -------------------------------------------

    /// Solver6 override (SHDRS6:207-221): base check, then — for vias only —
    /// the future-connection trace clearance.
    fn is_node_too_close_to_obstacle(
        &self,
        x: f64,
        y: f64,
        z: f64,
        parent: u32,
        margin: Option<f64>,
        is_via: bool,
    ) -> bool {
        if self.is_node_too_close_to_obstacle_base(x, y, z, parent, margin, is_via) {
            return true; // :212-214
        }
        if is_via && self.is_via_too_close_to_future_connection_trace(x, y) {
            return true; // :216-218
        }
        false // :220
    }

    /// Base isNodeTooCloseToObstacle (SingleHighDensityRouteSolver.ts:349-430).
    fn is_node_too_close_to_obstacle_base(
        &self,
        x: f64,
        y: f64,
        z: f64,
        parent: u32,
        margin: Option<f64>,
        is_via: bool,
    ) -> bool {
        let margin = margin.unwrap_or(self.obstacle_margin); // :350  margin ??= this.obstacleMargin

        if is_via && parent != NONE_IDX {
            // :352-369 — inline parent-chain walk: a via sits at pathNode
            // whenever pathNode.z !== pathNode.parent.z.
            let via_clearance = self.via_diameter / 2.0 + margin; // :356
            let mut path_node = parent; // :357
            let mut path_parent = self.nodes[path_node as usize].parent; // :358
            while path_parent != NONE_IDX {
                // :359-368
                let pn = self.nodes[path_node as usize];
                let pp_z = self.nodes[path_parent as usize].z;
                if pn.z != pp_z && distance(x, y, pn.x, pn.y) < via_clearance {
                    return true;
                }
                path_node = path_parent;
                path_parent = self.nodes[path_node as usize].parent;
            }
        }

        let trace_proximity = self.trace_thickness + margin; // :371
        if !self.obstacle_segments.is_empty() {
            // :372-391 — collectSegmentCandidates(:637-667) inlined as the
            // linear bbox scan (§6.14); candidate order = ascending index,
            // identical to the TS linear branch.
            let q_min_x = x - trace_proximity;
            let q_min_y = y - trace_proximity;
            let q_max_x = x + trace_proximity;
            let q_max_y = y + trace_proximity;
            for i in 0..self.obstacle_segments.len() {
                // :659-664 bbox rejects
                if q_max_x < self.seg_box_min_x[i] {
                    continue;
                }
                if q_max_y < self.seg_box_min_y[i] {
                    continue;
                }
                if q_min_x > self.seg_box_max_x[i] {
                    continue;
                }
                if q_min_y > self.seg_box_max_y[i] {
                    continue;
                }
                let segment = &self.obstacle_segments[i]; // :382
                if segment.connected_to_current_connection {
                    continue; // :383 (`!segment ||` can't occur: ids are dense)
                }
                if !is_via && segment.z != z {
                    continue; // :384
                }
                if point_to_segment_distance(x, y, segment.ax, segment.ay, segment.bx, segment.by)
                    < trace_proximity
                {
                    return true; // :385-389
                }
            }
        }

        let via_proximity = self.via_diameter / 2.0 + self.trace_thickness / 2.0 + margin; // :393
        if !self.obstacle_vias.is_empty() {
            // :394, :409-426 — linear branch ("Same box test the index would
            // apply, then the identical predicate").
            let q_min_x = x - via_proximity;
            let q_min_y = y - via_proximity;
            let q_max_x = x + via_proximity;
            let q_max_y = y + via_proximity;
            for i in 0..self.via_x.len() {
                let vx = self.via_x[i]; // :418
                if q_max_x < vx || q_min_x > vx {
                    continue; // :419
                }
                let vy = self.via_y[i]; // :420
                if q_max_y < vy || q_min_y > vy {
                    continue; // :421
                }
                if distance(x, y, self.obstacle_vias[i][0], self.obstacle_vias[i][1])
                    < via_proximity
                {
                    return true; // :422-424
                }
            }
        }

        false // :429
    }

    /// isViaTooCloseToFutureConnectionTrace (SHDRS6:175-205).
    fn is_via_too_close_to_future_connection_trace(&self, x: f64, y: f64) -> bool {
        let min_centerline_distance = self.via_diameter / 2.0
            + self.trace_thickness / 2.0
            + FUTURE_CONNECTION_VIA_TRACE_CLEARANCE; // :176-179

        for i in 0..self.future_connection_segments.len() {
            // :186-193 — bbox reject with 1+1e-9 safety slack (exact: bbox
            // distance lower-bounds true distance).
            let bbox = self.future_connection_segment_bboxes[i];
            let bx = js_max(js_max(bbox[0] - x, 0.0), x - bbox[2]); // :187  Math.max(minX-x, 0, x-maxX)
            if bx >= min_centerline_distance {
                continue; // :188
            }
            let by = js_max(js_max(bbox[1] - y, 0.0), y - bbox[3]); // :189
            if by >= min_centerline_distance {
                continue; // :190
            }
            let slack = min_centerline_distance * (1.0 + 1e-9); // :191
            if bx * bx + by * by >= slack * slack {
                continue; // :192-194
            }
            let segment = &self.future_connection_segments[i]; // :195
            if point_to_segment_distance(x, y, segment.sx, segment.sy, segment.ex, segment.ey)
                < min_centerline_distance
            {
                return true; // :196-201
            }
        }

        false // :204
    }

    /// isNodeTooCloseToEdge (:432-451). Uses only the node's x/y; z is
    /// irrelevant in the TS body.
    fn is_node_too_close_to_edge(&self, x: f64, y: f64, is_via: bool) -> bool {
        let margin = if is_via {
            self.via_diameter / 2.0 + self.obstacle_margin / 2.0 // :434
        } else {
            self.obstacle_margin / 2.0 // :435
        };
        let too_close = x < self.bounds.min_x + margin
            || x > self.bounds.max_x - margin
            || y < self.bounds.min_y + margin
            || y > self.bounds.max_y - margin; // :436-440
        if too_close && !is_via {
            // :441-449 — being near B or A is an exception.
            if distance(x, y, self.b[0], self.b[1]) < margin * 2.0
                || distance(x, y, self.a[0], self.a[1]) < margin * 2.0
            {
                return false;
            }
        }
        too_close // :450
    }

    /// doesPathToParentIntersectObstacle (:453-533). COLLINEAR_AUDIT
    /// (:483-518) is debug-only and excluded (PORT-SPEC §6.12).
    fn does_path_to_parent_intersect_obstacle(&self, x: f64, y: f64, z: f64, parent: u32) -> bool {
        if parent == NONE_IDX {
            return false; // :455
        }
        if self.obstacle_segments.is_empty() {
            return false; // :456
        }
        let p = self.nodes[parent as usize];

        // :458-461 (the second clause is always true past :456; mirrored).
        let clearance = if z == p.z && !self.obstacle_segments.is_empty() {
            self.nearby_segment_clearance
        } else {
            0.0
        };

        let min_x = js_min(x, p.x); // :463  Math.min(node.x, parent.x)
        let max_x = js_max(x, p.x); // :464
        let min_y = js_min(y, p.y); // :465
        let max_y = js_max(y, p.y); // :466

        // :468-473 collectSegmentCandidates(minX-c, minY-c, maxX+c, maxY+c),
        // inlined linear scan (§6.14).
        let q_min_x = min_x - clearance;
        let q_min_y = min_y - clearance;
        let q_max_x = max_x + clearance;
        let q_max_y = max_y + clearance;
        for i in 0..self.obstacle_segments.len() {
            // :659-664 bbox rejects
            if q_max_x < self.seg_box_min_x[i] {
                continue;
            }
            if q_max_y < self.seg_box_min_y[i] {
                continue;
            }
            if q_min_x > self.seg_box_max_x[i] {
                continue;
            }
            if q_min_y > self.seg_box_max_y[i] {
                continue;
            }
            let segment = &self.obstacle_segments[i]; // :478
            if segment.connected_to_current_connection {
                continue; // :479
            }
            if segment.z != z {
                continue; // :480
            }
            // :482, :519 — doSegmentsIntersect(node, parent, segment.A,
            // segment.B); argument order preserved (orientation is
            // order-sensitive at the epsilon).
            if do_segments_intersect(x, y, p.x, p.y, segment.ax, segment.ay, segment.bx, segment.by)
            {
                return true;
            }
            // :520-530
            if clearance > 0.0
                && get_segment_to_segment_centerline_distance(
                    x, y, p.x, p.y, segment.ax, segment.ay, segment.bx, segment.by,
                ) < clearance
            {
                return true;
            }
        }
        false // :532
    }

    // ---- Solution construction -----------------------------------------

    /// handleSimpleCases (:310-334): no obstacles, no future connections,
    /// A/B not on the same edge — solve in the constructor.
    fn handle_simple_cases(&mut self) {
        self.solved = true; // :311
        let a = self.a;
        let b = self.b;
        let route: Vec<[f64; 3]> = if a[2] == b[2] {
            vec![a, b] // :315
        } else {
            vec![
                a,
                [self.bounds_center_x, self.bounds_center_y, a[2]], // :318  {...boundsCenter, z: A.z}
                [self.bounds_center_x, self.bounds_center_y, b[2]], // :319-322
                b,
            ]
        };
        let vias: Vec<[f64; 2]> = if a[2] == b[2] {
            Vec::new() // :332
        } else {
            vec![[self.bounds_center_x, self.bounds_center_y]]
        };
        self.solved_path = Some(HdRoute {
            connection_name: self.connection_name.clone(), // :326
            root_connection_name: None,                    // :327 (M2 overwrites)
            region_id: None,                               // :328 (M2 overwrites)
            trace_thickness: self.trace_thickness,         // :330
            via_diameter: self.via_diameter,               // :331
            route,                                         // :329
            vias,                                          // :332
        });
    }

    /// setSolvedPath (:823-845) + getNodePath (:803-810): parent-chain walk,
    /// reverse, vias at every z change, route points + B appended.
    fn set_solved_path(&mut self, node_idx: u32) {
        let mut path: Vec<u32> = Vec::new();
        let mut n = node_idx;
        while n != NONE_IDX {
            // :805-809
            path.push(n);
            n = self.nodes[n as usize].parent;
        }
        path.reverse(); // :825

        let mut vias: Vec<[f64; 2]> = Vec::new(); // :827
        for i in 0..path.len().saturating_sub(1) {
            // :828-832
            let pa = self.nodes[path[i] as usize];
            let pb = self.nodes[path[i + 1] as usize];
            if pa.z != pb.z {
                vias.push([pa.x, pa.y]);
            }
        }

        let mut route: Vec<[f64; 3]> = path
            .iter()
            .map(|&i| {
                let node = self.nodes[i as usize];
                [node.x, node.y, node.z]
            })
            .collect(); // :840-841
        route.push(self.b); // :842  .concat([this.B])

        self.solved_path = Some(HdRoute {
            connection_name: self.connection_name.clone(), // :835
            root_connection_name: None,                    // :836 (M2 overwrites)
            region_id: None,                               // :837 (M2 overwrites)
            trace_thickness: self.trace_thickness,         // :838
            via_diameter: self.via_diameter,               // :839
            route,
            vias, // :843
        });
    }
}

// ===========================================================================
// Tests — structural smoke checks only; bit-exactness is proven against the
// TS golden capture (PORT-SPEC §7) by the M3 harness.
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{Bounds, ConnSlice, Hp};

    /// Heap tie behavior, hand-traced against the TS algorithm:
    /// enqueue f=[1(a), 1(b), 0(c)] -> heap [c, b, a]; dequeues yield
    /// c(0), then b(1) BEFORE a(1) — the load-bearing equal-f inversion.
    #[test]
    fn heap_tie_order_matches_ts_trace() {
        let mut q = SingleRouteCandidatePriorityQueue::new(Vec::new());
        q.enqueue(HeapEntry { f: 1.0, idx: 0 }); // a
        q.enqueue(HeapEntry { f: 1.0, idx: 1 }); // b
        q.enqueue(HeapEntry { f: 0.0, idx: 2 }); // c
        assert_eq!(q.dequeue().unwrap().idx, 2); // c
        assert_eq!(q.dequeue().unwrap().idx, 1); // b (not a!)
        assert_eq!(q.dequeue().unwrap().idx, 0); // a
        assert!(q.dequeue().is_none());
    }

    fn simple_input_slice() -> ConnSlice {
        let mut cs = ConnSlice::new();
        cs.intern("conn_a");
        cs
    }

    /// Obstacle-free, different-edge A/B on the same layer solves in the
    /// constructor (handleSimpleCases) with route [A, B].
    #[test]
    fn simple_case_solves_in_ctor() {
        let cs = simple_input_slice();
        let hp = Hp {
            cell_size_factor: 1.0,
            shuffle_seed: 0,
            fut_trace_pen: 2.0,
            fut_via_pen: 1.0,
            fut_prox_vd: 10.0,
            misaligned_pen: 5.0,
            via_pen2: 1.0,
            flip_trace: false,
            raw: Vec::new(),
        };
        let input = SrInput {
            conn: 0,
            a: [0.0, 0.5, 0.0],
            b: [1.0, 0.5, 0.0],
            bounds: Bounds {
                min_x: 0.0,
                max_x: 1.0,
                min_y: 0.0,
                max_y: 1.0,
            },
            min_dist_between_entering_points: 0.5,
            obstacle_routes: &[],
            future_connections: &[],
            layer_count: 2,
            available_z: &[0.0, 1.0],
            hp: &hp,
            conn_slice: &cs,
            via_diameter: 0.3,
            trace_thickness: 0.15,
            obstacle_margin: 0.15,
        };
        let solver = SrSolver::new(input);
        assert_eq!(solver.status(), SrStatus::Solved);
        let path = solver.solved_path().expect("simple case sets solvedPath");
        assert_eq!(path.route, vec![[0.0, 0.5, 0.0], [1.0, 0.5, 0.0]]);
        assert!(path.vias.is_empty());
        assert_eq!(solver.iterations(), 0);
    }

    /// After any step the observable progress is NaN (the B2 pipeline).
    #[test]
    fn progress_is_nan_after_step() {
        let cs = simple_input_slice();
        let hp = Hp {
            cell_size_factor: 1.0,
            shuffle_seed: 0,
            fut_trace_pen: 2.0,
            fut_via_pen: 1.0,
            fut_prox_vd: 10.0,
            misaligned_pen: 5.0,
            via_pen2: 1.0,
            flip_trace: false,
            raw: Vec::new(),
        };
        // A and B on the same (left) edge -> simple case disabled -> real A*.
        let input = SrInput {
            conn: 0,
            a: [0.0, 0.2, 0.0],
            b: [0.0, 0.8, 0.0],
            bounds: Bounds {
                min_x: 0.0,
                max_x: 1.0,
                min_y: 0.0,
                max_y: 1.0,
            },
            min_dist_between_entering_points: 0.5,
            obstacle_routes: &[],
            future_connections: &[],
            layer_count: 2,
            available_z: &[0.0, 1.0],
            hp: &hp,
            conn_slice: &cs,
            via_diameter: 0.3,
            trace_thickness: 0.15,
            obstacle_margin: 0.15,
        };
        let mut solver = SrSolver::new(input);
        assert_eq!(solver.status(), SrStatus::Running);
        solver.step();
        assert_eq!(solver.iterations(), 1);
        assert!(solver.progress().is_nan());
        // Run to completion within budget; must terminate solved or failed.
        let mut guard = 0u64;
        while solver.status() == SrStatus::Running {
            solver.step();
            guard += 1;
            assert!(guard <= 10_002, "solver failed to terminate");
        }
    }
}
