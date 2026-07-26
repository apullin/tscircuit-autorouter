# PORT-SPEC — Rust port of the dominant intra-node candidate solver

Scoping recon for RUST-PLAN.md §1 (tscircuit-autorouter repo): run all
portfolio candidates on rayon threads, select the winner with the
parity-proven replay semantics already in `native/replay-core`, return the
winner's routes. Candidates run TO COMPLETION (P2 replay proved selection
needs only final trajectories on the 100-iteration schedule grid).

All `file:line` citations are against this worktree
(`/home/pullin/personal/awt-perf-stack`, branch `perf-ts-stack`, commit
9b8eef54) unless prefixed with a repo path.

---

## 1. What CachedIntraNodeRouteSolver actually executes

`CachedIntraNodeRouteSolver` is **not** a wrapper around another solver
instance — it is a cache layer implemented **by inheritance** over the solver
that does the work:

```
PortfolioSingleIntraNodeSolver.generateSolver(hp)          (candidate factory)
  lib/solvers/HyperHighDensitySolver/PortfolioSingleIntraNodeSolver.ts:952-1053
  └─ default branch (no special hp key)  :1049-1052
     → new CachedIntraNodeRouteSolver({...constructorParams, hyperParameters})

CachedIntraNodeRouteSolver                       (295 LOC; cache in _step)
  lib/solvers/HighDensitySolver/CachedIntraNodeRouteSolver.ts:47-293
  extends
IntraNodeRouteSolver                             (631 LOC; per-connection loop)
  lib/solvers/HighDensitySolver/IntraNodeSolver.ts:52-590
  extends BaseSolver                             (lib/solvers/BaseSolver.ts:9)

IntraNodeRouteSolver._step (IntraNodeSolver.ts:408-487) pops one unsolved
connection and spawns, per connection (:483-486):

SingleHighDensityRouteSolver6_VertHorzLayer_FutureCost   (306 LOC; cost model)
  lib/solvers/HighDensitySolver/SingleHighDensityRouteSolver6_VertHorzLayer_FutureCost.ts:5
  extends
SingleHighDensityRouteSolver                     (1144 LOC; the A*)
  lib/solvers/HighDensitySolver/SingleHighDensityRouteSolver.ts:44
  extends BaseSolver
```

Where the iterations actually go: `SingleHighDensityRouteSolver._step`
(SingleHighDensityRouteSolver.ts:866-922) — dequeue best-f node from the
binary heap (`SingleRouteCandidatePriorityQueue`), packed-key dedupe against
`exploredNodes`, goal test, `getNeighbors` (:708-801 — 8 grid moves + one via
neighbor per other layer, each filtered through
`isNodeTooCloseToObstacle`/`isNodeTooCloseToEdge`/
`doesPathToParentIntersectObstacle`), enqueue. One candidate iteration = one
`_step` of the Cached/IntraNode solver = one A* pop-expand of the active
single-route solver (or one bookkeeping step: connection pop, branch queueing,
post-route repair check).

Cost model overrides that make this "solver 6": `computeG`/`computeH` at
SingleHighDensityRouteSolver6_VertHorzLayer_FutureCost.ts:281-305/270-279
(layer-direction misalignment penalty, `goalDist ** 1.6` heuristic,
future-connection proximity penalty via `Math.exp`), plus the via-vs-future-
trace obstacle extension (:207-221). `diminishCloseToGoal` (:226-229) is dead
code — never called.

Budgets: single-route solver `MAX_ITERATIONS = 10_000`
(SingleHighDensityRouteSolver.ts:181); candidate
`MAX_ITERATIONS = 1000 * totalConnections ** 1.5` (IntraNodeSolver.ts:173).
First sub-solver failure fails the whole candidate (IntraNodeSolver.ts:415-420).

Portfolio census (initial 70 candidates, enumeration in
PortfolioSingleIntraNodeSolver.ts:264-416): throughObstacle 1, singleLayer 1,
multiHeadPolyLine 2, majorCombinations(3)×orderings6(6)×cellSizeFactor(2)=36,
noVias 1, orderings50 20 (SHUFFLE_SEED 100-119, :350-353), flipTrace×orderings6
6, closedFormSingleTrace 1, A01 1, A03 1; adaptive expansion adds 5 more A01
(seeds 1-5, :544-554). **63 of 70 initial candidates are the
CachedIntraNodeRouteSolver class** (36+1+20+6). Measured winner mix (srj18
sample 8, 1210 nodes, tscircuit-autorouter perf-artifacts/parallelism-design.md
§4): CachedIntraNodeRouteSolver **1080 (89%)**, A01 82, A03 25, misc 23.

---

## 2. Port surface — dependency closure with LOC

"Core LOC" excludes `visualize()`, debug fields, `COLLINEAR_AUDIT`, comments.

### (a) Must port to Rust (core A* + cost + candidate loop)

| file | LOC | core | notes |
|---|---|---|---|
| lib/solvers/HighDensitySolver/SingleHighDensityRouteSolver.ts | 1144 | ~890 | A* loop, packed keys, obstacle predicates, SoA bbox arrays |
| lib/solvers/HighDensitySolver/SingleHighDensityRouteSolver6_VertHorzLayer_FutureCost.ts | 306 | ~300 | cost overrides; shared-cost memo; drop `diminishCloseToGoal` |
| lib/data-structures/SingleRouteCandidatePriorityQueue.ts | 125 | 125 | binary heap — tie behavior load-bearing, port verbatim |
| lib/solvers/HighDensitySolver/IntraNodeSolver.ts | 631 | ~495 | connection loop, dedupe+shuffle, fast paths, post-route repair |
| lib/solvers/HighDensitySolver/CachedIntraNodeRouteSolver.ts | 295 | ~250 | cache key + hit/save flow (§5) |
| lib/data-structures/HighDensityRouteSpatialIndex.ts | 533 | ~300 | only ctor/addRoute/getConflictingRoutesNearPoint used; a direct scan is result-identical (§6.14) → ~80 LOC option |
| lib/utils/cloneAndShuffleArray.ts | 105 | 105 | **bit-exact PRNG required** (§6.1) |
| lib/utils/getBoundsFromNodeWithPortPoints.ts | 32 | 32 | |
| lib/utils/getMinDistBetweenEnteringPoints.ts | 34 | 34 | |
| lib/solvers/BaseSolver.ts | 101 | ~50 | step/budget/progress-recompute semantics (§6.3-6.4) |
| lib/solvers/HyperParameterSupervisorSolver.ts | 190 | ~150 | schedule semantics — already mirrored by replay-core |
| lib/solvers/HyperHighDensitySolver/PortfolioSingleIntraNodeSolver.ts | 1148 | ~430 | computeG/H, expansion, budgets; parallel paths & stats stay TS |
| lib/cache/InMemoryCache.ts | 86 | ~40 | HashMap + deep-clone-on-read/write |
| vendored: @tscircuit/math-utils subset | — | ~60 | distance, pointToSegmentDistance, doSegmentsIntersect/orientation/onSegment (node_modules/@tscircuit/math-utils/dist/chunk-PUVNW6C2.js:11-75) |
| vendored: ConnectivityMap subset | — | ~30 | 3 methods (§3), incl. the asymmetric quirk (§6.11) |

**Honest core total ≈ 3,300 LOC of TS semantics** (~4,700 raw file LOC).
The winner-selection core is NOT in this total — it exists and is
parity-proven (native/replay-core/src/lib.rs, 1222/1222 nodes exact).

### (b) Stays in TS, results marshaled in/out

- Hyperparameter list enumeration (`getHyperParameterDefs`/
  `getCombinationDefs`/`getHyperParameterCombinations`) — candidate ORDER is
  the tie-break index; marshal the list per node exactly as
  `parallelReplayStep` already builds it (PortfolioSingleIntraNodeSolver.ts:646-661);
  never re-derive in Rust.
- Non-dominant candidate classes (A01/A03, MultiHeadPolyLine3, closed-form
  single/two-trace, singleLayer, throughObstacle — generateSolver branches
  :953-1047). Increment 1 runs them TS-side; their per-candidate records merge
  into the same selection (§8 contract C3).
- `extractWinningRoutes` (lib/solvers/HyperHighDensitySolver/extractWinningRoutes.ts:16-51, 51 LOC)
  + `repairDisconnectedSameRootPortPoints` (…/repairDisconnectedSameRootPortPoints.ts:56-135, 135 LOC)
  — run once on the winner's raw routes, TS-side after the FFI returns.
- `annotateRoutesWithTerminalPcbPortIds`
  (lib/solvers/HighDensitySolver/HighDensitySolver.ts:302-341) — downstream.
- GrowShrink outer loop (…/GrowShrinkHighDensityIntraNodeSolver.ts:143-175)
  — only its `externalMaxIterations` ceiling crosses in (§4).
- Cache-provider plumbing (lib/cache/setupGlobalCaches.ts, types.ts).

### (c) Already SoA / typed-array-friendly (direct translation)

- Obstacle bbox arrays + candidate-id buffer: `segBoxMinX/…/viaX/viaY`
  Float64Array, `candIds` Int32Array
  (SingleHighDensityRouteSolver.ts:113-120, 567-629, 637-667).
- Packed integer node keys replacing string keys (:74-87, 698-706).
- Trajectories as Float32Array on the schedule grid
  (lib/parallel/replayPool.ts:15-16, native/replay-core/datasetFormat.ts:76-89).
- Flatbush R-tree is droppable: order-insensitive consumers (§6.14).
- Object-heavy part that Rust fixes: A* `Node{x,y,z,g,h,f,parent}` linked via
  pointers — use an arena `Vec<Node>` + `u32` parent indices (parent-chain
  walk at :352-369, path reconstruction :803-845).

---

## 3. Candidate input surface

One candidate = **(node-shared input, hyperparameters)**. `generateSolver`
derives everything else. Session-per-node is the proven protocol
(lib/parallel/portfolioReplayWorker.ts:51-68 "session" message; board-level
variant lib/parallel/hdNodeWorker.ts:56-64; connMap rehydration =
`Object.setPrototypeOf(connMap, ConnectivityMap.prototype)`,
portfolioReplayWorker.ts:56-61).

### Node-shared input (crosses once per node)

- `nodeWithPortPoints` (lib/types/high-density-types.ts:13-21):
  `{capacityMeshNodeId, center{x,y}, width, height, portPoints[], availableZ?,
  portPointsInPairs?}`; PortPoint = `{connectionName, rootConnectionName?,
  portPointId?, pcb_port_id?, x, y, z, prev/nextPortPointId?}` (:1-11).
- Scalars: `traceWidth`, `viaDiameter`, `obstacleMargin`, `effort`
  (HighDensitySolver.ts:475-489 is the construction site; defaults 0.15 / 0.3 /
  0.15 / 1 at IntraNodeSolver.ts:112-114, PortfolioSingleIntraNodeSolver.ts:258).
- `obstacles`, `layerCount` — used ONLY by the throughObstacle candidate
  (:1031-1039); NOT needed by the Rust dominant class. `colorMap` is viz-only.
- connMap **slice** (see queries below).

### connMap queries the solve actually makes (net lookups only — never the full map)

| query | site |
|---|---|
| `areIdsConnected(solvedRoute.conn, currentConn)` | IntraNodeSolver.ts:239-244 (obstacleRoutes filter), :360-369 (via/trace conflict) |
| `areIdsConnected(this.conn, obstacleRoute.conn)` | SingleHighDensityRouteSolver.ts:545-550 |
| `getNetConnectedToId(connectionName)` | SingleHighDensityRouteSolver6…ts:139-151 (future-segment filter — inlined mirror of areIdsConnected) |
| `getIdsConnectedToNet(connectionName)` | CachedIntraNodeRouteSolver.ts:157-166 — **cache key only**; note it passes a connection name as a net id |

All arguments are connection names present in the node → the sufficient slice
is `{idToNet: name→net for the node's names, nets: netMap[net] for those nets
(+ netMap[name] if a name is itself a net id)}`. Implementation of the class:
node_modules/circuit-json-to-connectivity-map/dist/index.js:46-118.

### Hyperparameters consumed by the dominant class

`CELL_SIZE_FACTOR`, `SHUFFLE_SEED`,
`FUTURE_CONNECTION_PROX_TRACE_PENALTY_FACTOR`,
`FUTURE_CONNECTION_PROX_VIA_PENALTY_FACTOR`, `FUTURE_CONNECTION_PROXIMITY_VD`,
`MISALIGNED_DIST_PENALTY_FACTOR`, `VIA_PENALTY_FACTOR_2`,
`FLIP_TRACE_ALIGNMENT_DIRECTION` (class-field defaults at
SingleHighDensityRouteSolver6…ts:6-12; assignment loop :76-79; base
CELL_SIZE_FACTOR at SingleHighDensityRouteSolver.ts:154). Constant:
`FUTURE_CONNECTION_VIA_TRACE_CLEARANCE = 0.1`.

### Global config that can change semantics (assert unset for parity runs)

`TS_MAX_EXHAUSTIONS`, `TS_ABANDON_MAX_PROGRESS`, `TS_NODE_WORK_CAP`,
`TS_LEAN_PORTFOLIO` (PortfolioSingleIntraNodeSolver.ts:98-136 — all default
OFF), `TS_LINEAR_SCAN_MAX` (SingleHighDensityRouteSolver.ts:12 — perf-only,
result-identical), `COLLINEAR_AUDIT` (debug).

### Serialized size per node

Port points ≈130-200 B JSON each; typical node 4-16 points → 0.5-3 KB; connMap
slice 0.2-2 KB; scalars ~100 B. **≈1-6 KB/node typical, ~20 KB worst** — with
Rust threads it crosses the FFI once per node and is shared read-only by all
~75 candidates (the JS failure was cloning it per candidate per node:
parallelism-design.md §2 P1 postmortem).

### Pseudo-Rust input structs

```rust
struct NodeSession<'a> {
    node_id: &'a str,
    center: [f64; 2], width: f64, height: f64,
    port_points: Vec<PortPoint>,          // ORDER = TS array order (load-bearing)
    available_z: Option<Vec<f64>>,
    port_points_in_pairs_len: Option<u32>,// only feeds nodeSegmentCount
    trace_width: f64, via_diameter: f64, obstacle_margin: f64, effort: f64,
    conn: ConnSlice,
}
struct PortPoint { conn: u32 /*interned*/, root_conn: Option<u32>,
    x: f64, y: f64, z: f64 /* pcb_port_id etc. stay TS-side */ }
struct ConnSlice { id_to_net: HashMap<u32, u32>, nets: HashMap<u32, Vec<u32>> }

struct Hp {                                // dominant class only
    cell_size_factor: f64,                 // default 1
    shuffle_seed: i32,                     // 0 = NO shuffle (falsy check!)
    fut_trace_pen: f64,                    // default 2
    fut_via_pen: f64,                      // default 1
    fut_prox_vd: f64,                      // default 10
    misaligned_pen: f64,                   // default 5
    via_pen2: f64,                         // default 1
    flip_trace: bool,                      // default false
}
```

---

## 4. Candidate output surface

### Routes (winner only crosses back)

`HighDensityIntraNodeRoute` (lib/types/high-density-types.ts:37-58):

```rust
struct HdRoute {
    connection_name: String, root_connection_name: Option<String>,
    region_id: Option<String>,             // = capacityMeshNodeId
    trace_thickness: f64, via_diameter: f64,
    route: Vec<[f64; 3]>,                  // x, y, z
    vias: Vec<[f64; 2]>,
}
```

Re-entry path: winner's raw `solvedRoutes` → TS
`extractWinningRoutes(solver, nodeWithPortPoints)` (rootConnectionName
annotation + same-root repair; called from `onSolve`,
PortfolioSingleIntraNodeSolver.ts:1143-1147) → GrowShrink `acceptSolution`
(descale by 1/scaleFactor if a growth attempt rescaled the node,
GrowShrinkHighDensityIntraNodeSolver.ts:160-175) → HighDensitySolver pushes to
`this.routes` with `annotateRoutesWithTerminalPcbPortIds`
(HighDensitySolver.ts:288-341 sequential, :375-383 parallel). GrowShrink also
imposes `externalMaxIterations` on the portfolio
(GrowShrink…ts:150-157 → PortfolioSingleIntraNodeSolver.ts:434-462) — the Rust
supervisor must honor the same ceiling.

### Per-candidate record needed by replay selection

Exactly what replayPool consumes (lib/parallel/replayPool.ts:10-20, 108-145)
and RPLYDS01 stores (native/replay-core/datasetFormat.ts:54-70):

```rust
struct CandidateRecord {
    hp_index: u32,            // position in the marshaled hp list = tie-break index
    solved: bool,             // failed == ran to completion && !solved
    iterations: u64,          // final BaseSolver.iterations
    max_iterations: u64,      // post-setup MAX_ITERATIONS (1000*n^1.5 here)
    solved_segments: i64,     // -1 for this class (no solvedConnectionsMap;
                              //   only A01/A03 report >= 0 — replayPool.ts:17, 197-201)
    traj: Vec<f32>,           // schedule grid: sample k = raw progress after
                              //   min((k+1)*100, iterations) iterations
    error: Option<String>,
    routes: Option<Vec<HdRoute>>, // kept thread-local; only winner's cross
}
```

Selection = existing replay-core (`candidate_g` mirrors
PortfolioSingleIntraNodeSolver.computeG :925-943; the four cracked subtleties
are annotated in native/replay-core/src/lib.rs; acceptance semantics in
native/replay-core/README.md).

---

## 5. Cache semantics (CachedIntraNodeRouteSolver)

**What is cached:** final outcomes, INCLUDING FAILURES —
`{success:false, error}` vs `{success:true, solvedRoutes}` written on
completion (CachedIntraNodeRouteSolver.ts:283-291); a hit applies
solved/failed + routes/error and sets `progress=1`, so a hit candidate
completes at iteration 1 (:89-108, 210-226).

**Key composition** (schema v4, :111-208; coordinates center-relative, rounded
to 1/200 mm): node {width, height, center, sorted availableZ, port points
sorted by (connectionName, portPointId, x, y, z)}; `normalizedConnections` =
`initialUnsolvedConnections` **in post-SHUFFLE order** (captured after the
super() shuffle, :82 — so SHUFFLE_SEED affects the key via both the hp map and
the connection order); hyperparameters (undefined-filtered, key-sorted);
minDistBetweenEnteringPoints, traceWidth, viaDiameter, obstacleMargin;
`normalizedConnMap` = sorted unique `getIdsConnectedToNet(connectionName)` per
connection. Serialized as canonical JSON string, prefix
`intranode-solver:` (:193-207).

**Where it lives:** one per-process global
`globalThis.TSCIRCUIT_AUTOROUTER_IN_MEMORY_CACHE` (lib/cache/setupGlobalCaches.ts:24-28),
a `Map<string, structuredClone>` (lib/cache/InMemoryCache.ts:14-57). Bun
workers each get a cold private copy — that is the exact condition of the
measured **1-in-550 replay mismatch** at cmn_51 (parallelism-design.md §5
"failure-cache poisoning"; tscircuit-autorouter
perf-artifacts/pr-staging/issue-failure-cache.md; RUST-PLAN.md §1 names it the
blocker).

**Interaction structure (verified):** two candidates in one node never share a
key (distinct hyperparameters ⇒ distinct key), so within-node cache traffic is
zero. All hits are ACROSS solves (repeated node geometry; repair-stage
re-solves of the same node — GrowShrink growth attempts rescale coordinates,
changing the key).

**Recommended per-thread policy — "commit-on-sequential-semantics":**
one shared concurrent cache per Rust session; during a node, candidates READ
it (they see exactly the pre-node state — sequential visibility, since
within-node interaction is zero) but do not publish; after replay selection,
COMMIT only the entries the sequential schedule would have produced: candidates
whose virtual iterations reached completion when the winner landed
(`v[i] >= iterations` in replay state) plus the winner, in candidate-index
order. Nodes are processed in sequential order at the top level, so
this reproduces sequential cache evolution exactly and removes the
extra-failure-entry divergence class, not just bounds it.
Fallbacks: (a) per-thread caches — accept the known 1/550-class divergence and
quality-gate (RUST-PLAN §1 option 1); (b) no cache in Rust — semantically
cleanest (a v4 hit should equal a fresh compute; any difference IS the
poisoning bug), but re-measure hit rate first via
`stats.intraNodeCacheHits` (HighDensitySolver.ts:497-501).
Rust keys need only internal consistency — do NOT chase TS key-string equality
(§6.9-6.10).

---

## 6. Determinism audit (dominant-class closure)

Grep result: **no `Math.random` anywhere in the closure; no `Date.now` except
BaseSolver.solve wall-clock stat (BaseSolver.ts:65-69, timing-only).** The
items a Rust port must replicate exactly:

1. **Seeded shuffle** (lib/utils/cloneAndShuffleArray.ts) — the only PRNG.
   `seededRandom` (:1-33): LCG warm-up then xorshift128+ with JS int32
   semantics — `<<` wraps to i32, `>>>` yields u32, states may be negative,
   `(state0 + state1) / 4294967296` then `result - Math.floor(result)`.
   Arrays len ≤ 4 use the PRESHUFFLED_CASES tables (:38-78). `seed === 0`
   returns the array UNSHUFFLED (:81), and `SHUFFLE_SEED: 0` skips shuffling
   entirely (falsy check, IntraNodeSolver.ts:153). Per-connection point
   shuffle uses seed `i * 7117 + SHUFFLE_SEED` (:161-169).
2. **Application order**: connections shuffled first, then each connection's
   points (IntraNodeSolver.ts:153-170); connection pop order is
   `unsolvedConnections.pop()` — LIFO from the tail (:424).
3. **JS NaN semantics are load-bearing (the B2 finding).**
   `BaseSolver.step` re-computes progress with a zero-arg call (:52-55);
   `SingleHighDensityRouteSolver.computeProgress(currentNode, goalDist, isOnLayer)`
   (:847-864) then produces **NaN** (undefined arithmetic + `Math.max(x, NaN) → NaN`),
   so the sub-solver's observable progress is NaN after every step, and
   `IntraNodeRouteSolver.computeProgress` (:214-219) reduces to
   `solvedRoutes.length / totalConnections` because `NaN || 0 → 0`.
   That ratio can EXCEED 1: multipoint connections queue extra branches while
   `totalConnections` stays fixed (IntraNodeSolver.ts:307-327, :172). The
   portfolio's pre-expansion `computeH` uses this raw unclamped value
   (`1 - (progress || 0)`, PortfolioSingleIntraNodeSolver.ts:945-950) — raw
   progress > 1 ⇒ negative f is HOW winners get re-stepped (replay subtlety
   2). Post-expansion it switches to clamped `getCandidateProgress`
   (:192-198). Rust must implement `js_max/js_min` (NaN-poisoning, unlike
   `f64::max`) and `or_zero` (NaN→0) helpers and reproduce this exact pipeline.
4. **Iteration accounting**: `iterations++` BEFORE `_step`; budget failure
   check `iterations > MAX_ITERATIONS` AFTER (BaseSolver.ts:33-51);
   solved/failed short-circuit no-ops further steps (schedule slices stop
   advancing exactly as replayPool models with `min(100, iterations - v)`).
5. **Heap tie behavior**: SingleRouteCandidatePriorityQueue (:87-117) with
   strict `>` on heapifyUp, `rightChild.f < leftChild.f` and
   `heap[i].f < heap[child].f` break condition — equal-f ordering comes from
   these exact comparisons plus insertion order. Port the algorithm verbatim;
   any "equivalent" heap reorders equal-f pops and changes routes.
   `getNeighbors` emission order (dx −1..1 outer, dy −1..1 inner, then via
   neighbors in `availableZ` ascending) is likewise load-bearing
   (SingleHighDensityRouteSolver.ts:713-798).
6. **Map/Set order**: JS Maps iterate in insertion order — use `Vec`/IndexMap
   for `unsolvedConnectionsMap` (port-point order defines connection order,
   IntraNodeSolver.ts:115-150), `originalConnectionPointsByName`,
   `supervisedSolvers` (index = tie-break). `exploredNodes` is
   membership-only (`Set<number>` of packed keys — safe as `HashSet<i64>`).
   `conflictingRouteData` order affects only error text (§6.14).
7. **`Math.round` is NOT `f64::round`**: JS rounds half toward +∞
   (`Math.round(-2.5) = -2`; Rust gives −3). Implement
   `js_round(x) = (x + 0.5).floor()`. Used in the packed node key
   (:698-706), key-range setup (:209-216), initial node snap (:266-277), and
   the cache key's `roundCoord` (CachedIntraNodeRouteSolver.ts:16).
8. **Transcendentals**: `goalDist ** 1.6` (computeH, SHDRS6:272),
   `Math.exp` (future-connection penalty :265; also
   `totalConnections ** 1.5` budget, IntraNodeSolver.ts:173),
   `Math.atan` (progress metric :861-863 — feeds trajectories/schedule).
   `sqrt` is IEEE-exact (distance/pointToSegmentDistance are sqrt-based —
   chunk-PUVNW6C2.js:60-75 — safe). pow/exp/atan are not
   correctly-rounded-mandated; on linux-gnu both JSC (bun) and Rust `std`
   dispatch to glibc libm, so bit-parity is EXPECTED on this box but MUST be
   verified with the golden capture (per-candidate `maxIterations` directly
   checks the `** 1.5` budget; `traj` checks atan/exp/pow end-to-end). Any
   mismatch ⇒ vendor the exact function before proceeding.
9. **`toFixed(6)` point keys** (dedupe IntraNodeSolver.ts:35-50; repair graph
   repairDisconnectedSameRootPortPoints.ts:7-8): JS ToFixed decimal rounding
   vs Rust `format!("{:.6}")` can differ on exact decimal ties. Affects
   dedupe/graph identity. Implement JS ToFixed or prove no ties on the corpus
   via the harness.
10. **Cache-key strings**: `localeCompare` sort
    (CachedIntraNodeRouteSolver.ts:130-138) and JS `JSON.stringify` number
    formatting are locale/engine-shaped — do not attempt cross-language key
    equality; Rust caches are internally consistent (§5).
11. **ConnectivityMap quirk**: `areIdsConnected` is ASYMMETRIC —
    `netId1 === netId2 || netId2 === id1` (the `netId1 === id2` mirror case is
    absent; the condition is even duplicated in the source,
    circuit-json-to-connectivity-map/dist/index.js:98-105). Port as-is.
    SHDRS6's inlined mirror (:139-151) documents the same semantics.
12. **orientation epsilon**: relative `1e-12` collinearity test
    (chunk-PUVNW6C2.js:25-35) — port exactly (a spurious-true here changes
    obstacle rejection; see the COLLINEAR_AUDIT scaffolding,
    SingleHighDensityRouteSolver.ts:481-518, which is debug-only and excluded).
13. **Float accumulation**: g accumulates along the parent chain
    (deterministic single order); no reductions with ambiguous order exist in
    the hot path. Keep scalar f64 ops in source order; no FMA, no fast-math,
    no auto-vectorized reassociation on the cost paths.
14. **Flatbush / spatial index are replaceable**: every consumer of
    `collectSegmentCandidates` and the via query early-returns on ANY hit
    (isNodeTooCloseToObstacle :372-427, doesPathToParentIntersectObstacle
    :453-533), so candidate ORDER never affects the boolean — a linear bbox
    scan is result-identical (this is why `TS_LINEAR_SCAN_MAX` is
    semantics-free). Same for the post-route conflict check: first-conflict
    selection iterates `solvedRoutes` in deterministic order
    (IntraNodeSolver.ts:346-384); `conflicts[0]` feeds only the failure error
    string.

---

## 7. Golden capture

**Hook point**: `PortfolioSingleIntraNodeSolver.parallelReplayStep`,
immediately after `runReplayRace()` returns
(PortfolioSingleIntraNodeSolver.ts:667-693) — the single place where EVERY
candidate of EVERY class has run to completion (routes, iterations, full
trajectory per candidate) and the deterministic winner is known. Identical
placement, flag pattern and lazy-require discipline as the proven RPLYDS01
hook (native/replay-core/capture-hook.patch — now committed on this branch at
:679-693).

**Patch**: `native/golden-capture.patch` — verified `git apply --check` clean.
Adds a 17-line `TS_GOLDEN_DUMP`-gated hook plus one new file
`native/replay-core/goldenDump.ts` (152 LOC JSONL sink; per-100-iteration
trajectories via the existing `decimateTrajectory`, bit-exact on the schedule
grid per datasetFormat.ts:35-47). Do NOT apply while the benchmark gauntlet is
running.

**Format** (JSON-lines, one object per line):

- `{"t":"board", obstacles, layerCount}` — once per process (board-shared
  input; only the throughObstacle class consumes it).
- `{"t":"node", nodeId, nodeSegmentCount, initialCount, winnerIndex, node,
  params:{traceWidth,viaDiameter,obstacleMargin,effort}, connMap:{idToNet,nets}}`
  — per node. Shared input dumped ONCE per node (per-candidate inlining would
  multiply it ~75×); shared input + hp fully determines a candidate.
- `{"t":"cand", nodeId, i, hp, solved, iterations, maxIterations,
  solvedSegments, routes, error, traj}` — per candidate, `i` = tie-break
  index. `routes` are POST-`extractWinningRoutes` (the replay worker applies
  it per solved candidate, portfolioReplayWorker.ts:112) — the harness must
  apply TS `extractWinningRoutes` to Rust raw routes before comparing, or
  compare winner routes at the portfolio boundary.

**Runbook** (mirrors native/replay-core/README.md step 4; ~4 replay workers
keeps the box under its 8-bun-worker cap; wait for the gauntlet to finish):

```
git apply native/golden-capture.patch
env -u TS_PARALLEL_REPLAY2 -u TS_PARALLEL_HD_NODES -u TS_PARALLEL_A2 -u TS_LEAN_PORTFOLIO \
  TS_PARALLEL_PORTFOLIO=1 TS_PARALLEL_REPLAY=4 \
  TS_GOLDEN_DUMP=$PWD/native/srj18-sample8.golden.jsonl \
  bun scripts/run-sample.ts --pipeline 7 --sample 8 --dataset srj18
git apply -R native/golden-capture.patch
```

**Acceptance per candidate (Gate A feeder)**: `solved` equal; `iterations`
equal; `maxIterations` equal (validates the `** 1.5` budget); `traj` bitwise
equal as f32; routes deep-equal after TS extract. Winner parity via
replay-core (0 mismatches required between selections over identical records).
Anything involving the failure cache is judged against the 549/550-class
reference bar (native/replay-core/README.md "Acceptance bar").

---

## 8. Module split for 2-4 parallel port agents

Dependency order: M0 → M1 → M2 → M3. With 2 agents: (M0+M1) and (M2+M3).
Each module lands with golden unit tests against recorded vectors before the
next consumes it.

### M0 `geom-rng` (foundation, ~400 LOC, agent A)

Vendored math (distance, pointToSegmentDistance,
doSegmentsIntersect/orientation/onSegment with the 1e-12 relative epsilon),
JS-semantics helpers (`js_round`, `js_max`, `js_min`, `or_zero`,
`js_to_fixed6`), `seeded_random` + `clone_and_shuffle` (+ PRESHUFFLED tables),
interned-string ConnSlice with the asymmetric `are_ids_connected`.

**Contract C0**: pure `fn`s, property-tested against a TS-generated vector
file (inputs + expected outputs for shuffle seeds 0-119 on lengths 1-8, math
fns on corpus coordinates).

### M1 `sr-astar` (the kernel, ~1,300 LOC, agent B)

SingleHighDensityRouteSolver + 6_VertHorzLayer_FutureCost + priority queue +
packed keys + obstacle predicates (linear-scan SoA form) + simple-case
fast path + path reconstruction. Arena-allocated nodes.

**Contract C1**:
```rust
struct SrInput<'a> { conn: u32, a: [f64;3], b: [f64;3],
    bounds: Bounds, min_dist_between_entering_points: f64,
    obstacle_routes: &'a [HdRoute], future_connections: &'a [FutureConn],
    layer_count: u32, available_z: &'a [f64], hp: &'a Hp,
    conn_slice: &'a ConnSlice, via_diameter: f64, trace_thickness: f64,
    obstacle_margin: f64 }
enum SrStatus { Running, Solved, Failed }
impl SrSolver { fn new(SrInput) -> Self;        // may solve in ctor (simple case)
                fn step(&mut self);             // one A* iteration
                fn status(&self) -> SrStatus;
                fn iterations(&self) -> u64;    // MAX_ITERATIONS = 10_000
                fn solved_path(&self) -> Option<HdRoute>;
                fn error(&self) -> Option<&str> }
```
Stepping must be exposed (not run-to-completion) because M2 counts one
candidate iteration per sub-step.

### M2 `intra-node` (candidate state machine + cache, ~1,100 LOC, agent C)

IntraNodeRouteSolver loop (connection map build, dedupe, shuffle, LIFO pop,
multipoint branching, same-point-via fast path via an M1 obstacle-checker
instance, post-route via/trace conflict repair with reroute budget 2), the
progress semantics of §6.3, plus CachedIntraNodeRouteSolver key building and
the shared-cache client with commit-on-sequential-semantics (§5).

**Contract C2**:
```rust
impl CandidateSolver {  // == CachedIntraNodeRouteSolver semantics
    fn new(session: &NodeSession, hp: &Hp, cache: &SharedCache) -> Self;
    fn step(&mut self);                       // one candidate iteration
    fn iterations(&self) -> u64; fn max_iterations(&self) -> u64;
    fn progress(&self) -> f64;                // solvedRoutes.len/totalConnections (may exceed 1)
    fn status(&self) -> SrStatus;
    fn take_routes(self) -> Vec<HdRoute>;     // raw solvedRoutes
    fn pending_cache_entry(&self) -> Option<(KeyHash, CacheValue)>; // committed by M3
}
```

### M3 `portfolio-runtime` + FFI + harness (~700 LOC + glue, agent D)

Rayon run-to-completion of the dominant-class candidates with per-100
trajectory recording (sample = raw progress after each 100-iteration slice —
identical grid to decimateTrajectory); merge with TS-side records for
non-dominant candidates; winner selection by DEPENDING ON the replay-core
crate (do not rewrite `candidate_g`/the four subtleties); expansion and
`externalMaxIterations` mirrors; cache commit per §5; cdylib ABI in the
replay-core style (native/replay-core/README.md "C ABI"; stateful bun:ffi
recipe from the A01 port). Harness: JSONL golden comparator per §7.

**Contract C3 (FFI, flag `TS_NATIVE_PORTFOLIO`)**:
```
pf_session(node_json_ptr, len)      -> session handle   // NodeSession, once per node
pf_run(handle, hp_list_json, tsrec_json) -> result handle
    // hp_list = full marshaled candidate list in TS enumeration order;
    // tsrec   = CandidateRecords for candidates TS ran (non-dominant classes)
pf_result(handle, out_ptr, cap)     -> bytes of {winnerIndex, routes, perCandidate:[...]}
pf_free(handle)
```
TS side falls back to the sequential supervisor when the flag is off
(pattern: PortfolioSingleIntraNodeSolver.ts:824-828 gate).

### Gates (from RUST-PLAN.md §1, restated)

- Gate A: winner parity vs sequential on sample 8's full node corpus;
  549/550-class accounting, every mismatch attributed against the
  failure-cache issue.
- Gate B: HD-stage wall on samples 8/6, Tier-1 quality identical; continue
  only if parity holds AND HD-stage ≥1.3x at 8 threads; otherwise write the
  negative result in WINS.md and stop.
