# Hot numeric kernel inventory & SoA batch-API design (accelerator ladder, step 1)

Date: 2026-07-24. Read-only analysis; no source changes.

Evidence base:
- CPU profile `perf-artifacts/CPU.1626758000119.3553389.md` — srj18 **sample 8**, 365.01s wall,
  173,389 samples @ 2ms, captured on **main @ v0.0.714** (pre `perf/combined`).
- `perf-audit-2026-07-23.md` (audits 1-3), `WINS.md` (measured state as of 2026-07-24).
- Board stats measured from `dataset-srj18` sample008: **187 connections, 629 port points,
  477 obstacles, 4 layers, 55×22mm board**; routed output (srj18 benchmark result):
  **361 pcb_traces, 290 vias**; the original human-routed board (same PCB) has 1,410 wire
  segments at ~4-10 route points/trace — the autorouted+simplified output is the same order,
  so estimates below use **S ≈ 2,000-6,000 wire segments** board-wide.

**Provenance caveat (important):** the profile predates `perf/combined`. That branch already
harvested a large part of the #1 hotspot *algorithmically* (contiguity check excluded from DRC
candidate scoring; connMap base partition cached) — DRC was worth ~25-35% on nearly all samples.
The kernel ranking below stays valid because every residual DRC/geometry cost reduces to the same
point/segment-distance core, but expected wins vs `perf/combined` are smaller than the raw
profile percentages. **Re-profile `perf/combined` on sample 8 before building** (one
`bun --cpu-prof` run) to re-baseline the exact residuals.

---

## 1. Hot kernel inventory

Profile shorthand: self% / total% of 365s. Percentages >100% aggregation artifacts (recursive
`BaseSolver.step`) are avoided by using the flat self-time table. ~6% of the profile is
`graphics-debug`/`fflate` PNG export from run-sample — not in the benchmark path; ignore.

### K1. Segment-segment distance + intersection (`segmentsDistance`, `doSegmentsIntersect`, `orientation`, `doesLineIntersectLine`)

- **Where:** `node_modules/circuit-json-to-connectivity-map/node_modules/@tscircuit/math-utils/dist/chunk-CHQOCSFB.js`
  (`doesLineIntersectLine` :2, `doSegmentsIntersect` :11, `segmentsDistance` :33,
  `pointToSegmentDistance` :51). Additional bundled copies in top-level
  `@tscircuit/math-utils/dist/chunk-EFLPMB4J.js` and `chunk-Y7G4VXR7.js`
  (`segmentToSegmentMinDistance` :11) — the profiler reports 3-4 copies because each nested
  node_modules bundle is a distinct function.
- **Measured cost:** `segmentsDistance` copies **15.0% self** (31.25s + 15.34s + 6.42s + 1.56s);
  `doesLineIntersectLine` 4.0% self / **24.2% total (88.47s)**; `doSegmentsIntersect` copies 3.5%
  self; `orientation` 0.5%; native `Math.min` ~2.1% (3,659/3,908 min-samples come from
  `doesLineIntersectLine`'s spread `Math.min(...distances)`). Core family ≈ **22% self**.
- **Driving call sites:**
  - `circuit-json-to-connectivity-map/dist/index.js:214` `_buildTraceConnectivityMap` →
    `:249 _arePcbTracesConnected` → `doesLineIntersectLine` (42,195 of 44k inclusive samples).
    Constructed by `@tscircuit/checks` `checkTracesAreContiguous` (`dist/index.js:2087
    new PcbConnectivityMap`) → repo `lib/testing/getDrcErrors.ts:113` → `evaluate-relaxed-drc.ts`
    → `create-pipeline7-relaxed-drc-evaluator.ts` → `GlobalDrcForceImproveSolver` /
    `GlobalDrcBranchPortfolioSolver` (pipeline stages 20-21; 16 `getDrcSnapshot` call sites in
    `high-density-repair03`, ~3-9 candidates/iter). `_buildTraceConnectivityMap` alone is
    **25.0% total (91.55s)**.
  - Repo-side: `MultiHeadPolyLineIntraNodeSolver2_Optimized.ts:240` (dead `minDist` — result
    discarded, confirmed) and `MultiHeadPolyLineIntraNodeSolver.ts:205` (`computeMinGapBtwPolyLines`).
  - `SingleHighDensityRouteSolver.ts:357` `doSegmentsIntersect` in `doesPathToParentIntersectObstacle`.
- **Arithmetic shape:** inputs 8 floats (two segments' endpoints) + optional thickness; output
  1 float (min distance) or 1 bool. `segmentsDistance` = 1 exact-intersection test (4 orientation
  cross products) + 4 point-to-segment projections (each: 2 sub, dot, div, clamp, sqrt) ≈ 40 flops
  + 1-4 sqrt. Branch-light, no memory indirection beyond the 8 loads. Distances always compared to
  physical clearances ≥ 0.05mm (`(w1+w2)/2` ≥ 0.1mm here; checks `EPSILON = 5e-3`mm).
- **fp32 safety:** coords ≤ ±30mm (sample 8), ≤ ±250mm any realistic board. fp32 quantization at
  250mm = 1.5e-5mm; worst-case distance error after cancellation ~1e-4mm — 50x below the 5e-3mm DRC
  epsilon → **fp32 safe for all thresholded-distance uses**. Exception: the *exact* boolean
  `doSegmentsIntersect` sign test (`orientation`) near collinearity can flip in fp32; keep the
  zero-thickness predicate path in fp64 (it is not the hot path — `_arePcbTracesConnected` always
  passes `lineThickness > 0`).

### K2. Via-trace clearance (`checkViaTraceClearance` + `getTraceObstacleClearance` + `segmentToCircleMinDistance`)

- **Where:** `@tscircuit/checks/dist/index.js:2626` (`checkViaTraceClearance`; pair loop bodies at
  :2643/:2650), `:743 getTraceObstacleClearance`, `:721 getCenterBetweenCopperEdges`,
  `math-utils` `segmentToCircleMinDistance` (`chunk-Y7G4VXR7.js:75`), segments from
  `:679 getTraceSegments`.
- **Measured cost:** loop selves 2.7% (8.62s + 1.10s), `getTraceObstacleClearance` selves ~0.9%,
  `segmentToCircleMinDistance` 0.4%, `getCenterBetweenCopperEdges` ~0.3%, plus ~38% of native
  `hypot` (930/2472 samples ≈ 1.95s). Cluster ≈ **4.8% self (~17.5s)**.
- **Driving call site:** `lib/testing/getDrcErrors.ts:87` (per DRC snapshot, same repair stages as
  K1). Audit 2 #3: **O(V×S) with no spatial index** (sibling `checkPadTraceClearance` has one).
- **Arithmetic shape:** point(via center)-to-segment distance, minus radii → gap; compare to
  clearance. ~25 flops + 1 sqrt per pair; per-pair string work (`areIdsConnected` string map
  lookups, `pairId` template strings) currently costs as much as the math — `getNetConnectedToId`
  is 1.9% self (7.10s) largely from these loops. fp32 safe (same argument as K1).

### K3. Via-via spacing (`checkSameNetViaSpacing` :1774 / `checkDifferentNetViaSpacing` :1825)

- **Measured cost:** small on this profile (~0.3-0.5%: `viasAreAtSameLocation` +
  `checkDifferentNetViaSpacing` hypot shares). O(V²) done twice, sqrt per pair (audit 2 #11).
- **Shape:** point-point distance vs threshold; 290² /2 ≈ 42k pairs per call. fp32 safe.

### K4. Connectivity-map union-find (`findConnectedNetworks`, `ConnectivityMap`, `getNetConnectedToId`)

- **Where:** `circuit-json-to-connectivity-map/dist/index.js:2` (`findConnectedNetworks` — linear
  scan of all networks per node via `getOrCreateNetwork` :5, entries-array alloc per merge),
  `:95 getNetConnectedToId` (string-keyed lookups used per pair inside K2/K3 loops).
- **Measured cost:** `getNetConnectedToId` 1.9% self (7.10s); `findConnectedNetworks` +
  `getOrCreateNetwork` ~1.0% (3.7s); `_arePcbTracesConnected` loop selves 0.7%. Cluster ≈ **3.6%**.
- **Shape:** not numeric — set union over string ids, quadratic implementation. This is an
  **algorithmic TS fix** (proper DSU with path compression + interned int ids), not an
  acceleration target. Int-id interning also deletes the K2/K3 string-lookup tax.

### K5. HD A* per-probe geometry (repo `SingleHighDensityRouteSolver` family)

- **Where (lib/):** `SingleHighDensityRouteSolver.ts:258 isNodeTooCloseToObstacle`,
  `:330 doesPathToParentIntersectObstacle`, `:456 getNodeKey`, `:477/:492/:517 getNeighbors`,
  `:539 getNodePath`; `SingleHighDensityRouteSolver6_VertHorzLayer_FutureCost.ts:36
  getClosestFutureConnectionPoint`, `:93 isViaTooCloseToFutureConnectionTrace`,
  `:135 getFutureConnectionPenalty`.
- **Measured cost:** cluster ≈ **14% self** (getNodeKey 3.1%, getNeighbors ~2.4%, flatbush
  `search` ~2.2%, getNodePath ~1.5%, cloneObject 0.9%, isNodeTooCloseToObstacle selves ~1.0%,
  FutureCost selves ~1.9%, `pointToSegmentDistance` copies ~1.1%, `distance` 0.6%).
- **Status:** most of this is already fixed in TS by `perf/astar-hotloop` (packed numeric keys,
  post-rejection node construction, per-node G/H memo, cached future segments — measured ~12%
  on sample 5, 3x less garbage). The residual numeric op is 5-50 point-segment tests per probe
  after flatbush pruning — **inner-loop-sized, sequentially dependent on A* expansion order**.

### K6. MultiHeadPolyLine force relaxation (repo)

- **Where:** `lib/solvers/HighDensitySolver/MultiHeadPolyLineIntraNodeSolver/`
  `MultiHeadPolyLineIntraNodeSolver2_Optimized.ts:98 applyForcesToPolyLines`
  (`:144 endpointForce`, `netForces` init :114, integration loop :458), parent
  `MultiHeadPolyLineIntraNodeSolver.ts:156 computeMinGapBtwPolyLines`.
- **Measured cost:** `endpointForce` 0.9% self (3.58s), `applyForcesToPolyLines` selves ~0.4%,
  `segmentToSegmentMinDistance` ~0.8% (of which line :240 is a **confirmed dead call**),
  `pointToSegmentClosestPoint` ~0.2%, `computeMinGapBtwPolyLines` 1.19s total. Cluster ≈
  **2.5% (~9s)**.
- **Shape:** per candidate: n polylines (n = unique connections in node, 2-6), each ≤ 7 points
  (`SEGMENTS_PER_POLYLINE: 6` in the portfolio variant), z-assignments fixed per candidate.
  Per force substep: all same-layer segment pairs across line pairs (≤ C(6,2)·~36 ≈ 540
  endpoint-force evals), via×segment, via×via, same-line via pairs, exponential falloff
  `C·exp(-6·d)`, then explicit Euler `x += F` with boundary clamp/exponential wall. 10 substeps
  per candidate step. See §4 for the linear-system analysis.

### K7. Upstream A01/A03 grid solvers (`@tscircuit/high-density-a01`)

- **Where:** `HighDensitySolverA01.ts:633/:668 stepOnce`, `:745 computeMoveCostAndRips`,
  `fillViaOccupants`; `HighDensitySolverA03.ts:1790 forEachCellNearCircle`,
  `:1361 pushFlatOccupants`, `:1327 fillViaOccupants`.
- **Measured cost:** cluster ≈ **10.4% self (~38s)** (`forEachCellNearCircle` 4.8% total).
- **Shape:** already flat-typed-array grid state (`usedCellsFlat`, `penalty2d`, `cellCenterX[]`);
  cost is per-expansion occupancy scans in a sequential rip-up/reroute A*. Data-dependent,
  tiny per-op, upstream package. Not an SoA-extraction target; upstream micro-opts only.

### K8. TinyHypergraph pathing (`tiny-hypergraph`, 30% of stage-level wall)

- **Measured cost (function level):** diffuse — `computeG` copies ~2.9% self, heap ops ~1.5%,
  `countNewIntersections` 0.3%, hypot share ~0.8%. No single numeric kernel; it is graph search
  with dynamic blocker costs. Excluded from the SoA ladder (its levers are the audit-3 TS fixes
  + worker parallelism).

### Cluster totals (sample 8 profile, self-time)

| Cluster | ~Self % | Batchable? |
|---|---|---|
| K1 segment-distance family (DRC/connectivity driven) | 22% | yes — huge |
| K2 via×trace clearance | 4.8% | yes — large |
| K4 union-find + string net lookups | 3.6% | no — TS algorithmic fix |
| K5 HD A* probe geometry | 14% (mostly already fixed in TS) | no — sequential |
| K6 polyline force relax | 2.5% | per-call tiny; cross-candidate only |
| K7 A01/A03 upstream grid | 10.4% | no — sequential, upstream |
| K3 via×via spacing | <0.5% | yes but trivial |
| PNG export (not benchmark path) | ~6% | — |

---

## 2. Batchability analysis

Fixed offload costs assumed: worker hop (structured clone or transferable) ~50-500µs; native FFI
call on typed arrays ~0.1-1µs; GPU PCIe h2d+launch+d2h floor ~20-50µs per dispatch. Single-thread
pure-TS throughput on a scalar point-seg distance ≈ 50-100M ops/s; SoA-TS ~2-4x that; native
SIMD ~1-2G ops/s; GPU ~50-100G ops/s.

### K1 — trace-pair segment distances (connectivity / trace-overlap)

- **Natural batch:** all same-layer segment pairs from all non-connected trace pairs, one board
  snapshot. Two-level: (a) 361 traces → 64,980 trace pairs; (b) per pair, p₁×p₂ segment tests with
  early-exit-on-hit (hit is rare → near-full product). With 6-15 segs/trace: **2.3M-15M
  segment-pair distance ops per `PcbConnectivityMap` build**, over only ~2-6k unique segments
  (**48-100KB of coordinates**). The 91.55s total / ~0.6-1s per build implies **~100-150 builds**
  per sample-8 run (repair candidate scoring).
- **Verdict: the only kernel with a genuinely offload-sized batch.** Compute:transfer ratio ~10⁵:1.
  A GPU would do one build in ~1ms vs ~600ms scalar TS. **BUT** the honest comparison is against
  the algorithmically fixed version: bbox/spatial-hash pruning collapses 65k trace pairs to O(T·k),
  ~1-5% survivors → 50-300k distance ops → **5-15ms in SoA TS**, and `perf/combined` already
  removed most builds from the scoring path entirely. Offload wins only if brute-force shape is
  deliberately retained or DRC eval count is scaled up (portfolio-wide parallel scoring).

### K2 — via×segment clearance

- **Natural batch:** all (via, same-layer segment) pairs per DRC snapshot: 290 × ~2-6k, layer
  filter ~/2 → **0.3-0.9M point-segment ops per call**, ~60KB data. Same per-call cadence as K1.
- **Verdict:** batchable and worthwhile — but the same flatbush prune used by
  `checkPadTraceClearance` cuts it to ~10-50k ops, after which it rides K1's kernel for free
  (identical core op). Offload alone: marginal; as a second call site of the K1 batch API: free.

### K3 — via×via spacing

- 42k point-pair ops ×2 checks per snapshot. Milliseconds in scalar TS once sqrt→distSq. Batch
  API variant is 10 lines; not a driver of the design.

### K4 — union-find

- Not numeric; batch concept doesn't apply. The quadratic `getOrCreateNetwork` scan and per-pair
  string lookups are fixed by DSU + int interning in TS. **Gates nothing on the accelerator path**
  (but int net-ids ARE a prerequisite for clean SoA marshaling — see §3 owner/net columns).

### K5 — HD A* probes

- **Natural batch:** none that survives the solver structure. Each probe (≤50 ops post-flatbush)
  gates the *next* A* expansion — offload latency (even a native call is fine, but a worker/GPU
  hop is not) sits on the critical path millions of times. Restructuring A* into batched frontier
  expansion (GPU A*) is a full-solver rewrite, not a kernel extraction. **Too small; CPU-native
  inline scalar only.** The future-connection penalty (O(5-50) points per neighbor) was already
  memoized per node in `perf/astar-hotloop`.

### K6 — polyline force relaxation

- **Natural batch (per call):** one candidate's interaction set ≈ 100-1,500 pair interactions,
  ~10-50k flops per substep; 10 substeps between candidate re-scorings. **Per-call batch is 3-4
  orders of magnitude below GPU dispatch amortization.**
- **Cross-candidate batch:** the portfolio runs ~60 candidates/node and GrowShrink queues many
  nodes; batching *all active candidates* could reach 10⁴-10⁵ points. But candidate scheduling
  (A* pop by f, accept/kill decisions between substep bursts) is host-side and interleaved →
  device round-trip per 10-substep burst per candidate cohort. Feasible as a design, unjustified
  at 2.5% of wall.
- **Verdict:** pure-TS SoA rewrite in place (audit 1 #8: hoist per-pair array rebuilds, reusable
  Float64Array force accumulators, delete the dead :240 distance call, local scalar distSq
  kernels). Worker-parallel across candidates if ever needed.

### K7 / K8 — grid A* and hypergraph pathing

- Sequential, data-dependent, per-op tiny; K7 additionally upstream. **Not batchable without
  full-solver restructuring.** Excluded.

### Key finding

After the algorithmic fixes that are already merged or audit-listed (contiguity-out-of-scoring,
connMap caching, spatial pruning, DSU), **no kernel in this pipeline retains a per-call batch
large enough for PCIe offload to beat a pruned CPU-SoA implementation**. The K1/K2 family is the
only one that is even *close* (millions of ops, tiny data), and it is exactly the one whose batch
the algorithmic fix shrinks by ~50x. Therefore: build the SoA boundary for K1/K2/K3 as a
**pure-TS win with a backend seam**, treat GPU as an option that activates only if the roadmap
multiplies DRC-eval counts (e.g. massively parallel candidate scoring), not as the payoff of
step 1.

---

## 3. SoA batch API design

Location: `lib/geometry/batch/` (repo-owned; upstream packages keep their scalar paths — the repo
evaluator (`lib/testing/getDrcErrors.ts` scoring variant) and repo solvers adopt the batch API;
upstreaming is a later PR). All kernels: no allocation, no strings, caller-owned buffers,
void-return writing into `out` params. Canonical dtype **Float32Array for coordinates** (validated
safe in §1/K1 for thresholded distances; predicates that need exactness stay scalar fp64), int ids
as Int32Array. A `Float64Array` twin of the reference backend exists solely for byte-identical
A/B claims.

```ts
// ---- Data tables (built once per DRC snapshot / per candidate, mutated incrementally) ----

/** One row per wire segment, struct-of-arrays. */
export interface SegmentTable {
  ax: Float32Array; ay: Float32Array;   // segment start
  bx: Float32Array; by: Float32Array;   // segment end
  halfWidth: Float32Array;              // thickness/2 (mm)
  layer: Int32Array;                    // interned layer id
  net: Int32Array;                      // interned connectivity net id (from DSU)
  traceId: Int32Array;                  // interned pcb_trace id (row -> trace grouping)
  count: number;                        // rows in use (arrays may be over-allocated)
}

/** One row per via / circular obstacle. */
export interface CircleTable {
  x: Float32Array; y: Float32Array;
  radius: Float32Array;
  layerMask: Int32Array;                // bitmask of layers the via spans
  net: Int32Array;
  count: number;
}

// ---- Kernels (backend-swappable) ----

export interface GeometryBatchBackend {
  /** distSq between explicit segment pairs: out[k] = d²(segA[ai[k]], segB[bi[k]]). */
  segmentPairDistSq(
    a: SegmentTable, b: SegmentTable,
    ai: Int32Array, bi: Int32Array, n: number,
    outDistSq: Float32Array,
  ): void

  /** Threshold join: emit all (i,j) with same layer, different net, and
   *  d(segA_i, segB_j) <= maxDist[i]+maxDist[j] (per-row slack = halfWidth + clearance).
   *  Internally bbox-grid pruned. Returns pair count written. */
  segmentSegmentPairsWithin(
    a: SegmentTable, b: SegmentTable,
    clearance: number,
    outAi: Int32Array, outBi: Int32Array, outDistSq: Float32Array,
    capacity: number,
  ): number

  /** Point(circle)-to-segment gap: out[k] = d(c[ci[k]], seg[si[k]]) - r[ci[k]] - halfWidth[si[k]]. */
  circleSegmentGap(
    c: CircleTable, s: SegmentTable,
    ci: Int32Array, si: Int32Array, n: number,
    outGap: Float32Array,
  ): void

  /** All circle pairs with gap < clearance (via-via spacing). Returns count. */
  circlePairsWithin(
    c: CircleTable, clearance: number,
    outI: Int32Array, outJ: Int32Array, outGap: Float32Array, capacity: number,
  ): number

  /** Strict intersection booleans for explicit pairs (fp64 orientation predicate). */
  segmentPairIntersects(
    a: SegmentTable, b: SegmentTable,
    ai: Int32Array, bi: Int32Array, n: number,
    outFlags: Uint8Array,
  ): void
}
```

Notes:
- **True SoA (separate arrays), not interleaved**: enables SIMD gather-free loads in native
  backends and coalesced access on GPU; JS loops over separate Float32Arrays JIT well in
  JSC/bun.
- **Pair-list (gather) + join variants**: the join form owns the pruning (grid hash on segment
  AABBs inflated by halfWidth+clearance) so all backends benefit; the gather form serves callers
  that produce their own candidate pairs (flatbush results, polyline pair loops).
- **distSq everywhere**; a single `sqrt` at the boundary only where the caller needs a metric
  gap (circleSegmentGap does radius subtraction post-sqrt internally since gap semantics need it).
- Interning tables (`string trace/net/layer -> int`) built once per snapshot; this *also*
  eliminates the K4 string-lookup tax at the call sites.

### Marshaling at the driving call sites

1. **Trace-overlap connectivity (K1)** — repo-local replacement for
   `PcbConnectivityMap._buildTraceConnectivityMap` used by the evaluator: build `SegmentTable`
   from circuit-json wire segments (one pass, same fields as checks' `getTraceSegments`), call
   `segmentSegmentPairsWithin(segs, segs, 0 /* thickness carried in halfWidth */)`, then map
   surviving pairs to trace-pair unions via `traceId` rows into the DSU. Per-candidate
   incremental variant: only 1-2 routes change per repair candidate (audit 2 #1) → maintain the
   table with per-trace row ranges and re-join changed rows against the grid.
2. **Via-trace clearance (K2)** — in the scoring evaluator: `CircleTable` from vias,
   `circleSegmentGap` over layer-mask-filtered pairs from the same grid prune; compare
   `outGap + EPSILON >= minClearance` and emit errors only for survivors (error-object/string
   construction leaves the hot loop; semantics preserved incl. overlap-suppression by
   post-filtering `gap <= 0` pairs).
3. **Via-via spacing (K3)** — `circlePairsWithin` twice (same-net/diff-net masks via `net`).
4. **Polyline solver (K6, pure-TS backend only)** — per candidate, keep points in per-candidate
   Float64Arrays (x, y, z1, z2 columns); `computeMinGapBtwPolyLines` uses the gather-form
   `segmentPairDistSq`/`circleSegmentGap`; `applyForcesToPolyLines` keeps its bespoke force loop
   but on the SoA columns with reusable force accumulators (audit 1 #8) — it needs closest-point
   *vectors*, not just distances, so it shares the core scalar helpers rather than the batch API.

### Golden-output validation harness

- **Capture:** a bench-mode flag wraps the *new* call sites: after marshaling, dump each batch's
  input tables + pair lists + the outputs of the scalar reference (current library functions run
  over the same pairs) to binary files (`perf-artifacts/golden/<callsite>/<n>.bin`). Tier-0/Tier-1
  runs (sample 5; samples 5,8,10) generate the corpus.
- **Replay:** a test iterates corpora × backends: assert
  `|out - golden| <= max(1e-9, 2e-4)` mm for distances/gaps (fp32 bound with margin), booleans
  exactly equal except pairs whose golden distance lies within ±2e-4 of the threshold — those are
  counted and reported (expected ~0; must never change a DRC error at `EPSILON = 5e-3`).
- **End-to-end equivalence tiers (standing practice from WINS.md):** Tier 0 — with the fp64
  reference backend, sample-5 output byte-identical and iteration-count-identical vs main;
  fp32 backend — DRC **error-set identical** (ids + counts) on samples 5/8/10. Caveat recorded up
  front: DRC results feed candidate scoring, so an fp32 flip near a threshold can butterfly the
  route trajectory; the fp64 TS backend is the default until fp32 passes Tier-1 on all srj18
  completers.
- **Backend swap test:** the same corpus drives pure-TS, native (bun `dlopen` FFI on the same
  typed-array buffers, zero-copy), and any GPU backend — one contract, one harness.

---

## 4. NVIDIA library mapping

| Kernel | Library fit | Verdict |
|---|---|---|
| K1 segment-pair distances / threshold join | **cuSpatial**: `pairwise_linestring_distance` is exactly trace-pair min distance; quadtree spatial join (`quadtree_point_in_polygon`-family joins on bounding boxes) covers the prune. Thrust/CUB for pair compaction. | **Drop-in-shaped** — no custom kernel needed if offload is ever justified. |
| K2 via×segment gap | cuSpatial `pairwise_point_linestring_distance` minus radii. | Drop-in-shaped, rides K1's marshaling. |
| K3 via×via | Trivial transform+compact (Thrust) or one custom 20-line kernel. | Not worth dedicated effort; bundled with K1/K2 backend. |
| K4 union-find | cuGraph weakly-connected-components exists, but the graph is ~10²-10³ nodes / ~10⁴ edges. | **No.** DSU in TS is microseconds. |
| K5 / K7 / K8 A* families | cuGraph has SSSP/BFS on static weighted graphs; these solvers have dynamic costs (rip-up penalties, occupancy, hyperparameter portfolios) and host-side control flow per expansion. | **No** — would be a solver rewrite (batched-frontier GPU A*), not a library drop-in. |
| K6 polyline forces | See analysis below. | **Not cuDSS/cuSPARSE. Warp-shaped but batch-starved.** |
| cuBLAS / cuDSS anywhere | No dense linear algebra exists in the pipeline; no sparse linear systems exist (see below). | No target. |

### Is the MultiHeadPolyLine steady state a sparse linear system (K·x = f)?

**No — definitively.** From reading `applyForcesToPolyLines` (`MultiHeadPolyLineIntraNodeSolver2_Optimized.ts:98-566`),
`endpointForce` (:144), the netForces accumulation (:114), and the integration loop (:458):

1. **There are no spring terms at all.** The force field is *pure repulsion*: endpoint-vs-segment,
   via-vs-segment, via-vs-via, all with magnitude `C · exp(-6·d)` and direction
   `(p − proj(p))/d`. A stiffness formulation K·x = f requires forces affine in x; here forces are
   exponential in distances that are themselves piecewise (closest-point projection clamps
   `t ∈ [0,1]`, switching between perpendicular-foot and endpoint distance regimes).
2. **State-dependent branching in the force law:** via forces switch multiplier ×4 when
   `d < viaDiameter/2` (:274, :323, :372); pair participation is gated by layer equality (static
   per candidate, since z-assignments are fixed) but the *piecewise regime* changes every step.
3. **Not even a gradient system:** `endpointForce` distributes the reaction as −f/2 to *each*
   endpoint of the opposite segment (:169-170) instead of the (t, 1−t) split the true gradient of
   d(p, seg) requires — it is a heuristic force scheme, so there is no exact energy whose Hessian
   you could assemble.
4. **Boundary handling is a hard clamp** for non-via points (:524-531) and an exponential wall for
   vias — a complementarity condition, not a linear constraint.
5. **Multiple equilibria are the point.** The candidate A* enumerates via configurations/orderings
   precisely because different homotopy classes have different fixed points; the solver also
   *consumes intermediate state* (`magForceApplied` drives h and requeueing at :62-90; acceptance
   fires mid-relaxation when `minGaps` clears threshold). Jumping to a steady state via an
   implicit solve would change which equilibrium — and which answer — you get.
6. Even if one linearized per-Newton-step: the system is ≤ (6 lines × 5 movable points) × 2 =
   **~60-84 DOF**. Dense LU at that size is sub-microsecond on CPU; cuDSS/cuSPARSE has no role at
   any size this problem reaches.

Correct classification: a tiny contact/particle relaxation — NVIDIA **Warp**'s domain by shape,
but at ~10-50k flops per call it never amortizes a device dispatch. If it ever grows hot, the
right accelerations are in-place TS SoA (audit #8), Anderson/heavy-ball acceleration of the
fixed-point iteration, or worker-parallel candidates — not GPUs.

### Connectivity/pathing → cuGraph?

`findConnectedNetworks` is connected components over a few hundred nodes — cuGraph WCC would
spend more time on host-device transfer than the entire TS DSU fix takes to run.
TinyHypergraph pathing mutates edge costs during search (blocker resources, rips) with host
decisions between expansions; no cuGraph primitive matches. **Both: no.**

---

## 5. Recommended ladder

Value = measured profile share × batch size × independence from solver control flow.

| Rank | Kernel | Profile share | Typical batch | Decision |
|---|---|---|---|---|
| **1** | **K1 segment-pair distance/join** | 22% self / 25% total via connMap | 2.3-15M ops per snapshot ×~100+ snapshots; 48-100KB data | **Extract first — the reference SoA boundary** |
| 2 | K2 via×segment gap | 4.8% | 0.3-0.9M ops per snapshot | Second call site of the same boundary (shared core op) |
| 3 | K3 via×via | <0.5% | 84k ops | Free rider on the boundary |
| 4 | K6 polyline forces | 2.5% | 10-50k flops/call | TS SoA in place; **no offload** |
| — | K4 union-find | 3.6% | n/a | **TS algorithmic fix** (DSU + int ids); prerequisite for SoA marshaling, not an accelerator target |
| — | K5 HD A* probes | 14% (mostly harvested) | ≤50 ops/probe, sequential | **Not worth extracting** — inline scalar TS |
| — | K7 A01/A03 | 10.4% | sequential | Skip (upstream, already flat arrays) |
| — | K8 hypergraph pathing | ~5% fn-level / 30% stage | sequential | Skip; lever is workers + audit-3 fixes |

**First extraction: K1 as `segmentSegmentPairsWithin` + `segmentPairDistSq`** (with K2/K3 as
sibling entry points in the same backend interface), integrated at the repo-owned DRC scoring
evaluator. Rationale: largest measured cost by far; the only offload-sized batch; pure function of
8 floats per pair (cleanest golden validation, byte-identical fp64 tier available); serves four
distinct call-site families (connectivity, trace-overlap, via clearance, polyline min-gap);
and its SoA tables are the same transferable typed-array encoding the planned worker-parallel
dispatch needs — one boundary, three payoffs.

**Expected outcome, stated honestly:** against the *profiled* baseline (main), the pure-TS SoA +
grid-prune backend should recover most of the ~90s of connMap time on sample 8 — but
`perf/combined` already recovered much of that algorithmically, so measure against both; the
realistic incremental win on `perf/combined` is the residual DRC geometry in final checks,
non-scoring paths and K2 (est. mid-single-digit % per heavy sample, plus enabling incremental
per-candidate DRC). The strategic value is the boundary itself: a validated, backend-agnostic
contract where native/CUDA (cuSpatial drop-in shape, no custom kernels) or Tenstorrent backends
can be slotted **if and when** parallel candidate scoring multiplies the batch count — with the
harness and marshaling already paid for.

**Explicitly not worth accelerating:** K5 (batch too small, sequential — already fixed in TS),
K6 on any offload backend (batch 1000x too small; and its steady state is *not* a linear system,
so no cuDSS shortcut exists), K4 (algorithmic TS fix), K7/K8 (sequential control flow; restructure
cost dwarfs kernel cost). These are the places where accelerator effort would be wasted.
