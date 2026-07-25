# tscircuit-autorouter perf audit — 2026-07-23

Goal: speed up `AutoroutingPipelineSolver7_MultiGraph` (pure TS, single-threaded per board).
Machine: 64-thread x86, 123 GB RAM, bun 1.3.14. All numbers local unless noted.

## Benchmark set (srj18, `./benchmark.sh --dataset 18`)

Local baseline: 11/16 completed, 5 timeouts (samples 2, 6, 12, 14, 15), P50 118.7s, P95 320.6s.
CI baseline (v0.0.714, 32vCPU ARM): 9/16, 7 timeouts, P50 113.1s.

Standing per-sample benchmark picks:
- **sample008** — heaviest completer (~337s, 45 DRC errs): main profile target
- **sample010** — slow but DRC-clean (~164s): quality-preserving regression check
- **sample005** — fast completer (~35s): sanity check
- **sample006** — timeout, stuck in HighDensitySolver (~1M phase iterations, 0% progress)
- **sample012** — timeout, stuck in GlobalDrcBranchPortfolioSolver (23 iterations in ~5 min)

Repro: `bun scripts/run-sample.ts --pipeline 7 --dataset srj18 --sample N [--effort E]`
Profile: `bun --cpu-prof --cpu-prof-md --cpu-prof-dir out scripts/run-sample.ts ...`
Stage-level: `bun scripts/profile-solvers.ts --dataset 18 --concurrency 16`

## Where the time goes

### Stage-level (11 completing srj18 samples, top-level stages only)
- HighDensitySolver ~498s (~58%)
- TinyHypergraphPortPointPathingSolver ~255s (~30%, 15.5M iterations)
- TraceSimplificationSolver ~48s + MultiSimplifiedPathSolver ~40s (~10%)
- Exact-geometry DRC stages: ~0 on completing samples, but the death of timeout samples 2 & 12
(Nested sub-solver rows in profile-solvers output double-count interleaved wall time — trust only top-level rows.)

### Function-level (sample008 CPU profile, 365s, in `perf-artifacts/`)
- ~25% total: segment geometry in dependency packages — `doesLineIntersectLine` 24.2% total,
  `segmentsDistance` (3 copies) ~14% self — from `circuit-json-to-connectivity-map`'s nested
  `@tscircuit/math-utils` + `@tscircuit/checks` (`checkViaTraceClearance` 3.4%). DRC/connectivity, not routing.
- `@tscircuit/high-density-a01` package (A01/A03 solvers): `forEachCellNearCircle` 4.8% total,
  `stepOnce` ~5.4%, `pushFlatOccupants`/`fillViaOccupants` ~10s — HD portfolio kernels live upstream too.
- `getNodeKey` string building 3.1% self; native `map/some/filter/find/Math.min-spread/Set/cloneObject/
  copyDataProperties` ≈ 10-15% (allocation tax); `Math.hypot` 1.4%.
- ~6% is run-sample PNG/graphics export — ignore (not in benchmark path).

## Audit 1 — HighDensity stage (lib/solvers/HighDensitySolver/*)

Hot path: HighDensitySolver._step → GrowShrinkHighDensityIntraNodeSolver → PortfolioSingleIntraNodeSolver
(100 substeps/step) → IntraNodeRouteSolver → SingleHighDensityRouteSolver6_VertHorzLayer_FutureCost A*.

Verified dead code (both confirmed by direct read):
- `SingleHighDensityRouteSolver6_VertHorzLayer_FutureCost.ts:156` — `goalDistRatio` computed (a divide after a `** 1.6` pow) and never used, per neighbor.
- `MultiHeadPolyLineIntraNodeSolver2_Optimized.ts:240` — `segmentToSegmentMinDistance` result (`minDist`) discarded; the library call does 4 allocating pointToSegmentDistance calls + spread Math.min, per same-layer segment pair × 10 force substeps.

Top findings (file:line, impact):
1. `...FutureCost.ts:164,192` — getFutureConnectionPenalty computed twice per neighbor (computeG+computeH), each an O(futurePoints) sqrt rescan; distance(node,B) computed up to 4×/expansion. HIGH
2. `...FutureCost.ts:155` — `** 1.6` (Math.pow) per neighbor + dead divide. HIGH
3. `...FutureCost.ts:99,72` — getFutureConnectionSegments() rebuilt per via-neighbor probe (rest-spread + object literals + invariant connMap lookups); cache in constructor. HIGH
4. `SingleHighDensityRouteSolver.ts:455-457,617-618` — string node keys (float→string per probe; getNodeKey also called redundantly); debug_* Sets/arrays fed unconditionally. Pack int cell coords into a number key; gate debug. HIGH (getNodeKey alone = 3.1% CPU)
5. `SingleHighDensityRouteSolver.ts:468-478` — neighbor objects spread-cloned BEFORE explored-set rejection; construct after checks, no `...node` spread. MED-HIGH
6. `SingleHighDensityRouteSolver.ts:262-268,536-554` — via checks materialize full ancestor path arrays per probe; walk parent chain inline or cache viaCount per node. MED
7. `SingleHighDensityRouteSolver.ts:254-256` — viaPenaltyDistance is a getter recomputed in per-point loops; make it a field. MED
8. `MultiHeadPolyLineIntraNodeSolver2_Optimized.ts:173-232` — per-pair rebuild of points/segments/vias arrays in O(n²) pair loop ×10 substeps; precompute per call. Via-via `layers.filter/includes` allocation per pair. netForces → reusable Float64Arrays. HIGH (for polyline solver)
9. `MultiHeadPolyLineIntraNodeSolver...ts:42,250-263` — candidates.shift() O(n) + splice-insert on arrays up to 50k; use existing SingleRouteCandidatePriorityQueue. MED
10. `MultiHeadPolyLineIntraNodeSolver.ts:156-248` — computeMinGapBtwPolyLines rebuilds Map-of-arrays + spreads per candidate; allocating library distance kernels. Local scalar kernels. MED
11. `Pipeline4HighDensityRepairSolver.ts:317` — `visualize()` called EVERY step of every repair sub-solver in production. Capture lazily. HIGH (repair stage)
12. `...FutureCost.ts:23-26` — hyperparameters sprayed onto `this` via for-in creates divergent hidden classes across A* instances → polymorphic ICs; declare all as class fields. MED
13. `PortfolioSingleIntraNodeSolver.ts:83-100,370-372` — portfolio budget re-derived with map/spread/reduce every supervisor step; cache. LOW-MED
14. `BaseSolver.ts:52-55` — `"computeProgress" in this` probe per iteration; also SingleHighDensityRouteSolver.computeProgress called with no args → returns NaN, overwriting real progress (perf-relevant correctness bug: portfolio fitness never sees true progress). LOW-MED + BUG
15. `CachedIntraNodeRouteSolver.ts:175,64` — objectHash (recursive SHA-1) + structuredClone per portfolio candidate (~60+/node); manual key serializer, hash per node not per candidate. MED
16. `SingleLayerNoDifferentRootIntersectionsIntraNodeSolver.ts:224-267` — Dijkstra with Set<string> linear min-scan, ×720 permutations in one un-preemptible _step. MED
17. math-utils `pointToSegmentDistance` allocates projection object per call in innermost collision loops; write local scalar pointSegDistSq, compare squared. LOW-MED
18. `HighDensityRouteSpatialIndex.ts:144,222-237` — template-string bucket keys + per-query string Sets; numeric keys + query-stamp ints. LOW

## Audit 2 — DRC repair phase (timeout pathology for samples 2, 12)

Code lives in git deps: `high-density-repair03` (GlobalDrcForceImproveSolver / GlobalDrcBranchPortfolioSolver);
checks in `@tscircuit/checks` (0.0.123 nested in dep for stage 1; 0.0.145 for exact stage) +
`circuit-json-to-connectivity-map`. Repo evaluator: `create-pipeline7-relaxed-drc-evaluator.ts` →
`lib/testing/evaluate-relaxed-drc.ts` → `lib/testing/getDrcErrors.ts`.

Structural answer: repair loop runs FULL-BOARD DRC PER CANDIDATE (7 getDrcSnapshot call sites;
~3-9 candidates/iter × 16+32+8+32 iters across stages/branches), incl. clone of all routes, full
circuit-JSON conversion, connectivity rebuild, O(T²·p²) contiguity check, O(V×S) via-trace clearance,
O(V²) via spacing — when only 1-2 routes changed.

Repo-fixable now (no upstream release):
- **#2 Disable trace-contiguity in candidate scoring** (`includeTraceContinuity: false` in scoring path;
  repair moves can't fix contiguity anyway; keep for final report). Likely best single ROI.
  `lib/testing/getDrcErrors.ts:111-113`, `lib/testing/drcPresets.ts`, `evaluate-relaxed-drc.ts:32`.
- **#4 Cache connMap once in evaluator closure** (trace ids deterministic `${connection.name}_${i}`,
  source elements invariant → connMap identical every call). `lib/testing/getDrcErrors.ts:59`.
- #6 Memoize invariant circuit-JSON scaffolding (source traces/ports/pads) per srj; per candidate append
  only pcb_trace/pcb_via. `lib/testing/utils/convertToCircuitJson.ts:242-276`.
- #9 Hoist Map<name,__netConnectionName>; group hdRoutes once per candidate.
  `convertPipeline7HdRoutesToSimplifiedPcbTraces.ts:36-41`.
- #10 Pre-filter/spatial-hash multilayer obstacles in isThroughObstacleSegment.
  `lib/utils/convertHdRouteToSimplifiedRoute.ts:66-73`.

Upstream `high-density-repair03`: #1 incremental/scoped DRC re-check (structural, changes asymptotics);
#5 getDrcErrors builds no connMap → 3 quadratic rebuilds per candidate (nested checks 0.0.123);
#7 double route→trace conversion (one discarded); #8 getConnMapAwareSrj clones per candidate;
#12 cloneRoutes whole-board + toFixed string round-trips; #14-17 broad-pass rebuild/sort issues;
#18 regex-parsing error messages for severity; #19 64-variant detour array rebuilt per error/iter.

Upstream `@tscircuit/checks`: #3 checkViaTraceClearance O(V×S) no spatial index (sibling
checkPadTraceClearance HAS one — copy the pattern); #11 via spacing O(V²) twice, sqrt per pair;
#13 getReadableNameForPcbTrace linear-scans full soup per trace ERROR OR NOT (O(T×N) per call);
#20 addStartAndEndPortIdsIfMissing linear port scans per candidate; SpatialObjectIndex string bucket
keys + spread-clone per object per build.

Upstream `circuit-json-to-connectivity-map`: PcbConnectivityMap all-trace-pairs × all-segment-pairs
(this is the doesLineIntersectLine 24% in the CPU profile); findConnectedNetworks quadratic
union-find (linear scan per node, entries-array alloc per merge).

## Audit 3 — shared infra (BaseSolver/PriorityQueue/ObstacleTree/pathing)

1. **[HIGH — cheapest large win] `TinyHypergraphPortPointPathingSolver.ts:916-941`** — full `this.stats`
   object rebuilt per micro-step: ~15-key literal + 3 object spreads + 2 `.reduce()` closures +
   `getStageStats()` (allocates per stage, findIndex per stage) × ~4M iterations at effort 1.
   Fix: move to getStats()/onSolved or gate to every 1024 iters. Stage is 30% of runtime.
2. [HIGH] `CapacityPathingSolver.ts:291-297` (+ `CapacityPathingSingleSectionSolver.ts:360-366`) —
   A* open list: `sort()` + `shift()` + splice per expansion, lists up to 100k. Use a heap.
   (Family drives pipeline 1 more than 7 → Med for p7 product.)
3. [HIGH] `TinyHypergraphPortPointPathingSolver.ts:1082-1084` + pipeline7 `:532-539` — `computeNodePf`
   calls `getOutput()` (full output rebuild) per node + `.find()` scan → O(N²·P) at HD-stage handoff.
   Fix: build output once, Map lookup.
4. [HIGH] `SingleHighDensityRouteSolver.ts:455-457` — float-formatted string node keys (same as audit 1 #4);
   pack int grid coords into number keys.
5. [HIGH] `SingleHighDensityRouteSolver.ts:468-473` — `{...node}` spread per neighbor (same as audit 1 #5).
6. [HIGH] `buildHyperGraph.ts:190-196` — `regions.find` per segment port point → O(S×R) at stage entry;
   also `TinyHypergraphPortPointPathingSolver.ts:444-449` and `getRegionNetIdByRegionId.ts:206-215`
   (O(C·P·R)). Fix: Map<regionId, region>.
7. [MED-HIGH] `BaseSolver.ts:52-55` — `"computeProgress" in this` prototype probe per step of every solver;
   `CapacityPathingSingleSectionSolver.computeProgress:457-459` does O(open-list) reduce per step →
   quadratic. Cache capability bool; throttle progress polling; track min-h incrementally.
8. [MED-HIGH] `...FutureCost.ts:98-107` — future-connection segments rebuilt per via check (= audit 1 #3).
9. [MED] Debug bookkeeping unconditionally on: `debugEnabled = true` HARDCODED at
   `SingleHighDensityRouteSolver.ts:90`; `debug_lastNodeCostMap.set` + `{f,g,h}` alloc per neighbor in
   CapacityPathing solvers (`:349-353` / `:414-418`). Gate behind real flag, default off.
10. [MED] `CapacityPathingSolver.ts:196-203` — neighbor gen via flatMap/filter/map (3 closures + 3 arrays
    per expansion); precompute adjacency Map in constructor.
11. [MED] `CapacityPathingSingleSectionSolver.ts:161,203,216` — getTunedTotalCapacity1 (2 fractional pow +
    sqrt) recomputed per neighbor though `totalNodeCapacityMap` cache exists; penalty computed 2×/neighbor
    (also CapacityPathingSolver5.ts:115-136).
12. [MED] `CapacityNodeTree.ts:54-57` — 0.4mm string-keyed cells vs 16mm nodes → ~6,400 template strings +
    Map probes + `|| []` allocs per query in CapacityMeshEdgeSolver2. Numeric keys, proportional cell size.
13. [MED] `HighDensityRouteSpatialIndex.ts:218-231,331-355` — Map + 2 string Sets + string key per cell per
    query; removeRoute filters EVERY bucket O(total entries). Numeric keys, generation-counter dedup,
    per-route bucket lists.
14. [MED] `ObstacleTree.ts:133-152` native backend — string keys, `|| []`, float-stride world-coordinate
    loop that CAN SKIP THE LAST ROW/COLUMN (latent missed-obstacle bug). Dead code in p7 (all callers pass
    "flatbush") but it's the default param — flip default to "flatbush".
15. [LOW-MED] `FlatbushIndex.ts:29-32` — `.map().filter(Boolean)` double array per query, on the real
    production query path (TraceWidth/Repair/Keepout/UselessVia/SameNetViaMerger).
16. [LOW-MED] `HighDensitySolver.ts:322-384` — updateCacheStats() up to 3×/step.
17. [LOW-MED] `getNodeEdgeMap.ts:8-12` — `[...(map.get(id) ?? []), edge]` re-spread per edge insert →
    O(E·deg); plain push.
18. [LOW] math-utils `pointToSegmentDistance` — projection object + sqrt per call; local scalar sq-distance
    kernel (callers compare thresholds).
19. PriorityQueue verdicts: `lib/data-structures/PriorityQueue.ts` is a correct binary heap but DEAD CODE
    (nothing imports it) with a silent drop-at-10k landmine; `SingleRouteCandidatePriorityQueue` (the one
    actually used) is sound — minor nits only. The CapacityPathing sort-per-pop family should adopt the heap.
20. BaseSolver.step() pump is otherwise lean: try/catch ~free on JSC, Date.now only brackets solve().
    Real per-step costs = #7 probe/dispatch + wrapper-layer work like #1; 4 nested step() frames per
    pathing iteration means anything added to _step bodies is ×millions.

## Next: parallel dispatch (discussion planned, not yet designed)

Observations so far: per-sample solve is single-threaded; benchmark harness already parallelizes
across samples. Natural intra-sample shard points: HighDensity portfolio candidates (~60+ independent
candidate solvers per node), GrowShrink node queue (independent nodes), GlobalDrcBranchPortfolioSolver's
3 branches, and candidate scoring in repair (independent full-board DRC evals). Bun has Worker support;
structured-clone cost of srj/routes per dispatch is the main design constraint (consider transferable
typed-array encodings — synergizes with the flat-data refactors above).
