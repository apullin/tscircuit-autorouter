# WINS.md — measured speedups (untracked scratch log)

Rules: only *measured* results land here, with the measurement context. Aspirational items stay in
perf-audit-2026-07-23.md. Baselines: main @ v0.0.714 (b7b243cc), 64-thread x86, bun 1.3.14.

## Confirmed

- **2026-07-25 — REJECTED: exact grid coordinates + future-point memo.** No speed, mixed quality.
  Hypothesis (good one, and it was structurally real): the HD A* explores on a QUANTIZED cell key
  (`getPackedNodeKey` rounds to cellStep) but computes costs on RAW coordinates built by
  accumulating `node.x + dx*cellStep`. So one logical cell has many float representations
  depending on the path taken there — the source of dust like 19.45000000000001 — which (a) blocks
  memoization and (b) fed the upstream collinear bug.
  Fix built: derive every position as `gridOrigin + index*cellStep` from an integer index, clamp in
  INDEX space. Coordinates became path-independent, and the future-point memo then verified EXACT
  (grid-only and grid+memo hash identically, a0156491 on sample 5).
  Measured (2 interleaved rounds, quality metrics not hashes since results legitimately change):
  | board | wall legacy -> exact | vias | segments | median trace |
  |---|---|---|---|---|
  | sample 8 | 101s -> 100.4s | 290 -> 291 | 2857 -> 2792 | 4.016 -> 3.95mm |
  | sample 6 | 238s -> **254s (+6.7%)** | 290 -> 291 | 3974 -> 4223 | 3.90 -> 4.018mm |
  Quality moves in OPPOSITE directions on the two boards and there is no speed win. The memo fails
  because the scan it replaces already has cheap early-rejects (~20-100ns) while a Map lookup over
  a 200k-entry table costs the same — independently reproducing round 6's "85.9% call redundancy
  but memoizing is 11% slower", this time with integer keys. The redundancy is real and worthless.
  Reverted. NOTE the structural observation stands and is worth keeping: quantized exploration with
  unquantized costs is a latent inconsistency, and `Math.round(0.5)` behaviour at the half-cell
  start offset makes cell assignment sensitive to dust.

- **2026-07-25 — REJECTED: exhaustion-based node abandonment. Fast on most boards, catastrophic
  on one.** Commit 2c4a73da, `TS_MAX_EXHAUSTIONS`, shipped OFF.
  Targets the nodes consuming 68-88% of HD search that fail anyway. Single boards looked like a
  free win — sample 8 125s/45 DRC -> 90s/41 at K=30; sample 6 268s/99 -> 213s/94 — faster AND
  cleaner, because the freed budget goes to repair.
  **The corpus gate killed it**: srj18 1708.4s -> 1379.7s (1.238x) but DRC 581 -> 801, with +218
  of that from sample 2 alone (7 -> 225). dataset01 unaffected (easy boards never reach 30
  exhaustions). Sample 2 needs K=70 to stay safe; sample 8 wants K=10-30. No global K works.
  A hopelessness guard (`TS_ABANDON_MAX_PROGRESS`, abandon only if no candidate ever routed more
  than P of the node) protects sample 2 but erases the speed: the doomed nodes DO reach >25%
  progress — they route most connections then cannot place the last one or two.
  **Conclusion: a doomed node is not locally distinguishable from a hard one** — not by geometry
  (4 bounds tested), not by exhaustion count, not by progress. The information isn't at the node.
  Lesson for future work: always gate on the full corpus. Two boards showed a 1.4x win with better
  DRC; the third showed a 32x DRC regression.

- **2026-07-25 — HD A* obstacle queries: drop the R-tree for small sets. +4.7% sample 8,
  +5.3% sample 6, BIT-IDENTICAL.** Commit 54dab7b0 on perf/ts-round3.
  After the math-utils fix, `flatbush.search` was the single biggest function on sample 6
  (23.2s, 8.2% of wall), and 96% of it came from two call sites: `isNodeTooCloseToObstacle`
  (69.7%) and `doesPathToParentIntersectObstacle` (26.3%) — up to ~20 tree descents per A*
  expansion, two array allocations each, plus one R-tree construction per solver.
  Measured set sizes (sample 5, 2104 indexes): ~90% hold <=32 segments, 82% hold <=2 vias.
  A Flatbush over 2 items is pure overhead. Now bboxes live in Float64Arrays and small sets
  are scanned linearly using the *same* bbox test the index applies, so candidate sets and
  decisions are identical; the tree is still built above TS_LINEAR_SCAN_MAX (default 64).
  Interleaved A/B: sample 8 107.6s -> 102.8s (hash 4f723847 in all 4 runs); sample 6
  259.1s -> 246.1s (hash b11cd11b in all 4 runs).
  Threshold sweep on sample 8 was monotonic toward always-linear (102.8 / 101.9 / 101.5 /
  100.7 / 100.2s for 0 / 32 / 64 / 128 / inf) but inside that board's ~4% run-to-run noise,
  so the default stays at 64 to bound the worst case on very large obstacle sets.

- **RETRACTED 2026-07-25 — "Peak memory 1.2x-2.9x lower than main" was WRONG.** It came from a
  single unrepeated pass of `/usr/bin/time -f %M`. Repeating it interleaved gave main 1317MB vs
  current 1384MB on sample 5 and main 2447MB vs current 5287MB on sample 8 - i.e. the opposite -
  and the *same code* moved 3x between runs. Peak RSS on this workload tracks JSC's opportunistic
  heap growth (it expands when the box looks free), not what the program retains. `bun --smol`
  made it worse, not better (5713MB vs 1957MB at equal wall time).
  **Use live set instead**: heapUsed after a forced `Bun.gc(true)`, sampled periodically
  (`~/.perf-scratch/mem-probe.ts`). On that metric, main vs current is a wash:
  sample 5 361MB -> 278MB (-23%), sample 8 398MB -> 428MB (+7.5%), sample 6 main cannot finish.
  Live sets are only 278-1060MB, so two thirds of "memory usage" is heap slack and memory is not
  currently a binding constraint per process.
  **Live-set composition at peak (sample 8, V8 snapshot, 731.8MB attributed):** strings 287.6MB
  (39.3%, 1.0M of them), engine-internal 249.2MB (34%), Float64Array 60.4MB (8.3%), plain objects
  34.6MB (4.7%, 522k of them), closures 15MB. Two 32MB BigUint64Arrays are the snapshot
  generator's own tables, not ours.
  Consequences: (a) f32/integer *coordinates* would save ~4% of the live set - they are a
  correctness and cache argument, not a memory one; (b) the real memory hog is string identifiers,
  but those are only **2.1% of CPU** (areIdsConnected 0.52%, Set 0.59%, getElementId 0.46%), so
  interning is a memory-only play and memory is not the constraint. Deprioritized.

- **2026-07-25 — Peak memory: SUPERSEDED, see retraction above.**
  Measured end-to-end with `/usr/bin/time -f %M`, one process at a time on a quiet box,
  main (tscircuit-autorouter @ v0.0.714, pristine deps) vs current (awt-r3 perf-round3 +
  patched math-utils):
  | sample | main peak RSS | current peak RSS | change | wall |
  |---|---|---|---|---|
  | 5 | 3959 MB | 2730 MB | -31% | 57.0s -> 41.8s |
  | 8 | 2421 MB | 2001 MB | -17% | 349.1s -> 131.3s |
  | 6 | >=9613 MB (killed at 420s, still running) | 3310 MB | **-66%** | -> 286.2s |
  Practical consequence: memory (not cores) was the binding constraint for parallel benchmarking
  on this box. ~9.6GB/board allows ~12 concurrent routes in 123GB; ~3.3GB allows ~37.
  Credit is spread across the hidden-class field work (separately measured 3.59GB -> 1.17GB on
  sample 5), the A01 SoA node pool, lazy repair visualize(), and debug-flag gating.
  Single run per cell; harness PNG export included in both arms.

- **2026-07-24 — @tscircuit/math-utils geometry: Tier-1 1.10x, tail board 1.21x, quality EXACT.**
  The biggest clean win since the TS rounds, and it is entirely in a *dependency*. Profiling srj18
  sample 6 (352s) showed 24% of total wall inside math-utils: `pointToSegmentDistance` 14.5%,
  `orientation` 4.4%, `doSegmentsIntersect` 1.7%, `segmentToSegmentMinDistance` 1.5%. Dominant
  caller is `getSegmentBoardClearance` (high-density-repair03), 50k samples.
  Two fixes on branches in `~/personal/math-utils-fix` (based on origin/main = npm latest v0.0.36),
  PR-ready with notes in that repo's PR-NOTES.md:
  1. **Correctness**: `orientation()` compared the cross product to exactly 0, so for colinear input
     the cancellation dust's meaningless sign drove `doSegmentsIntersect` into its general case →
     disjoint colinear segments reported as intersecting → `segmentToSegmentMinDistance` returns 0
     for segments 0.424mm apart. Reaches DRC: @tscircuit/checks computes trace clearance from it.
     Fixed with a relative-epsilon colinearity test. 11 regression tests (3 fail before).
  2. **Perf**: dropped per-call allocations (bit-identical, 1.94x on the function) and replaced the
     "intersection predicate + 4 point-segment distances" formulation with the clamped parametric
     closest-point solve (4.93x; last-ulp differences only).
  Downstream A/B (2x2 interleaved, sample 6): 344s → 279.5s, **identical iteration count
  (2,981,684)** and identical DRC (99). Tier-1 (5,8,10,6,12): 685.3s → 620.9s (1.10x), every DRC
  count and via count identical, P95 288.2s → 244.5s.
  NOTE: `awt-ts2/node_modules/@tscircuit/math-utils/dist` currently holds the PATCHED build.
  Both dists archived at `awt-r3/perf-artifacts/math-utils-fix/`. A `bun install` reverts it.

- **2026-07-24 — Native A01 kernel (Rust): BIT-IDENTICAL (fnv1a on dataset01 sample001/002),
  1.65x kernel speedup — overall a WASH.** Full port in native/hdastar (cdylib + bun:ffi,
  stateful incremental API). Tier-1: sample 8 1.13x, samples 12/6 slower, vias +5-10 on 3 samples.
  Root cause: A01 is ~10% of HD-stage CPU and was already SoA-optimized TS — the JSC-vs-native gap
  on typed-array kernels is 1.5-3x, not 10x. Flag TS_NATIVE_A01, parked OFF. Value: the port
  recipe + stateful FFI pattern is proven for future kernels.

- **2026-07-24 — P2 replay stage 2 (online replay + early exit): output hash-IDENTICAL to
  sequential on samples 5/8, but 70% SLOWER at 4/8/12 workers.** Session protocol + streaming
  trajectories + harvest-time copies all work; early exit dispatches ≤24/70 candidates on 60% of
  nodes. Message-passing overhead (~0.25s/parallel-node × ~100-500 parallel nodes) exceeds
  loser-work savings. Third parallel-design data point: only A2-style data-selected
  deterministic branches pay; timing-dependent racing doesn't. Parked (TS_PARALLEL_REPLAY2).

- **2026-07-24 — Lean/dominant portfolio: REJECTED with the cleanest data of the campaign.**
  Winner distribution (1210 nodes, sample 8): top 4 combos = 85% of wins; 43/106 combos ever win.
  But: lean-15 = -5% sample 5, +6% sample 8 (schedule already ignores useless candidates —
  their cost is construction, not stepping); dominant-only = +46% sample 8 (the 45% of nodes
  it fails on ARE the expensive ones — the hard tail needs full search diversity).
  **The sequential, in-process, hyperparameter-diverse search on the heavy tail is well-matched
  to this hardware. Remaining real time is algorithmic stagnation (B1), a research problem.**

- **2026-07-24 — P2 deterministic replay: winner semantics SOLVED (549/550 nodes exact), parked.**
  Fitness model cracked: init-f = g(0) (polyline 31000), unclamped progress → negative f re-stepping,
  solved-at-0 selection, expansion triggers. Bit-identity blocked by CachedIntraNodeRouteSolver
  failure-cache poisoning (cmn_51: sequential replays a cached failure; cold worker computes truth).
  Stage-1 3.8x slower → not worth stage 2 without identity. Flag TS_PARALLEL_REPLAY, kept as
  reference (94ebff57). OPEN QUESTION for upstream: is the intra-node cache key complete
  (obstacle/solved-route state)? Failure entries may poison later solves — potential real bug.

- **2026-07-24 — A2 PARALLEL DRC BRANCH PORTFOLIO: first real parallelism win, BIT-IDENTICAL.
  Commit 075834b0, flag TS_PARALLEL_A2 (default off). Baseline ∥ broad repair branches in two Bun
  workers (SAB result channel + sleepSync sync pump); broad runs speculatively; selection replicates
  sequential snapshot-count comparisons exactly. Output hashes seq == par on samples 8/6/12
  (4f723847/b11cd11b/7c100f7f). Tier-1: sample 6 314.7→251.6s (1.25x), sample 8 117.6→104.4 (1.13x
  incl. rounds 5-6), sample 10 1.04x, 5/12 neutral, P95 311.6→234.1s, quality identical everywhere.
  Key design facts: broad derives from INPUT (not baseline output) → deterministic; DRC evaluator
  rebuilt worker-side from serializable config; connMap prototype rehydrated after structured clone.
  Memory note: 2 A2 workers per sample × benchmark concurrency — budget ~1.5GB/worker on big boards.

- **2026-07-24 — FULL GAUNTLET, round-6 state: srj18 16/16 COMPLETED (main: 11/16), zero timeouts,
  P50 63.3s (main 118.7s, ~1.87x cumulative). Quality parity exact: srj18 DRC-pass 3/16 = main;
  dataset01 85/85, 88.2% DRC pass, 40.04 avg vias — all matching main to the decimal.**
  perf-artifacts/full-srj18-round6.json + full-dataset01-round6.json.
- **2026-07-24 — Uint8Array explored-bitmap (5184a46e): NEUTRAL, reverted (ea8a4258).** Interleaved A/B
  0.99x/1.00x — JSC small-int Sets are already competitive with dense array indexing here.

- **2026-07-24 — Round 6 (2 commits): FutureCost exact rejects + pointToBoxDistance scalar inline.
  Interleaved A/B: sample 8 +1.5% (113.0→111.3), sample 12 ±0, quality identical, suite 419/0.**
  getClosestFutureConnectionPoint: float-exact z-penalty/|dx|/|dy| rejects skip most sqrt calls;
  isViaTooCloseToFutureConnectionTrace: bbox reject with 1+1e-9 ulp-safe slack; pointInsideObstacle:
  allocation-free scalar (clamp replicated exactly). tiny-hypergraph computeG residual (6.7% self)
  audited — no safe win: the cost is the intersection-count loop itself, already SoA-lean.

- **2026-07-24 — A01 SoA node pool (5e0e46ac): +4.3% on srj18 sample 8 (interleaved A/B), neutral elsewhere,
  bit-identical.** SearchNode object per A* neighbor → TypedSearchNodePool (mirrors A03). Interleaved
  pre/post ×2 under STEADY ambient load (klayout build, load ~12): sample 8 pre 112.4/113.4 → post
  106.0/110.4; sample 12 158.3 → 158.1 (noise). Micro: 260.4→236.2ms on dataset01 sample001 (1.10x).
  **METHODOLOGY: two sequential Tier-1 runs under varying klayout load gave contradictory results
  (fake -4% regressions on samples 5/10/12) — only the interleaved A/B is trustworthy. tier1-round5*.json
  are load-contaminated; do not cite.** Bit-identity: fnv1a + iterations identical on dataset01
  sample001/002; srj18 sample 5 iterations 1048233 == 1048233. Suite 419/0 (one flaky test seen once,
  passed on rerun).

- **2026-07-24 — Parallel portfolio race (P1 take-first): REJECTED by experiment.** Built the full
  mechanics (Bun Workers + SAB result channel + sleepSync sync pump, flag TS_PARALLEL_PORTFOLIO,
  c661278e). Sample 5: race×4 56.7s/15 DRC vs sequential 41.8s/0 DRC — slower AND worse quality.
  The sequential fitness schedule encodes a QUALITY preference that first-to-finish violates.
  Measured R=9.28 (aggregate candidate work / winner work, sample 8, 1210 nodes) justifies
  parallelism in principle; P2 (run-all + schedule replay) needs a session protocol (connMap is
  currently cloned per candidate per node) AND is blocked on B2.

- **2026-07-24 — B2 computeProgress NaN fix: REJECTED by experiment (branch perf/b2-progress, ed0039da).**
  Fixing the NaN made portfolio fitness progress-aware: samples 10/12 12% SLOWER, vias up 4/5 samples,
  sample 10 gained a DRC error (0→1). The NaN masking (schedule on work-consumed only) is de-facto
  correct. P2 parallelism needs a better progress metric, not the existing one.

- **2026-07-24 — perf/ts-round4 (3 commits + 1 revert): Tier-1 vs round-3 — sample 8 120.8→112.9s (+6.5%),
  samples 10/12 ~+1.5%, sample 6 still completes.** C7 memo TAUGHT A LESSON: 85.9% call redundancy in
  isNodeTooCloseToObstacle probes looked like ~6%, but the string-key memo REGRESSED sample 8 by 11%
  (126.9s vs 112.9s no-memo) — 3.8M template-string keys + Map ops cost more than the flatbush searches
  they replaced. **Measure TIME of the redundant work, not CALL count, before memoizing.** Reverted
  (6deca9b9); numeric-lattice-key variant parked (OUR_TODOS C7). Kept wins: determineOwnerPair WeakMap
  index (1815 find-samples), net-id hoisting round 2 (computeMinGapBtwPolyLines/getFutureConnectionSegments/
  isSameNetObstacle), TraceSimplification pre-filter, selective-rerip getRelaxedSearchHops 1.93x micro
  (799→414 ns/call). Tests 419/0; identity 1048233 preserved at every step.

- **2026-07-24 — perf/ts-round3 (repo-side lib + 9 dependency patch files): Tier-1 srj18 A/B vs ts-round2 baseline —
  1.27x aggregate on common samples, sample 6 (last hard timeout) now COMPLETES (323.7s < 360s CI cap).**
  Quiet box, sequential runs, 360s cap, per-sample: s5 1.04x, s8 1.32x, s10 1.27x, s12 1.27x;
  DRC counts/via counts/trace counts IDENTICAL on all common samples (result-identical preserved).
  Changes: checkViaTraceClearance spatial index (~8-9x micro; sibling-pattern), checks/connmap net-id
  lookup hoisting, A01+A03 fillViaOccupants inline + occupancy-version cache (A03 2.2x micro),
  tiny-hypergraph computeG hoisting + heap hole-sift, repair03 sharesNet/matcher (5→2 connMap lookups
  per pair), repo-side geometric-rejection-before-connMap reordering. Dep diffs live in perf-patches/
  (9 files + README); repo lib commit dd48f5f1 on perf/ts-round3. Tests 419/0.
  Confirmation run 2: s8 1.32x, s10 1.25x, s12 1.26x, s6 completes again (342.6s) — reproduces.
  **Two hard lessons:** (1) Math.hypot→sqrt in tiny-hypergraph computeG/H is float-nonidentical in ulps
  and FLIPS A* tie-breaks on real boards — broke 3 SVG snapshot tests (bugreport58/bugreport60) despite
  being output-identical on 4 synthetic configs; REVERTED, do not retry without accepting snapshot churn.
  (2) bun HARDLINKS node_modules into ~/.bun/install/cache and all worktrees — in-place edits contaminate
  every checkout + the cache. Round-3 npm-package edits had to be surgically restored (orig snapshots in
  /tmp/checks-r3/, git-dep caches verified clean). Apply dep changes with `patch` (breaks the link),
  never edit in place.

- **2026-07-23 — Test-suite wall time 30+ min → ~164s** (no code change): bun 1.3's `--parallel`.
  418 pass / 0 fail. Enables fast iteration; CI equivalent uses 5 sharded runners.
  **CAVEAT (learned 2026-07-24 the hard way): cap at `--parallel=8`.** The 164s figure was measured at 32
  workers, but that concurrency level — combined with parallel benchmarks — OOM-crashed the machine.
  Memory, not cores, is the binding constraint here. Expect somewhat slower but survivable runs at 8.

- **2026-07-24 — srj18 sample 12 (DRC-repair timeout pathology): DNF → completes.**
  Branch `perf/drc-scoring` (5b682a0c): exact-geometry DRC repair stage 23 iters/~300s (timeout >360s)
  → 41 iters / 55.7s (~13 s/iter → ~1.4 s/iter, ~10x per-iteration). Whole sample: 318.8s wall, solved,
  11 final strict DRC errors. Change: scoring-variant evaluator (contiguity check excluded from candidate
  scoring only; connMap base partition cached + per-candidate via layer; scaffold elements memoized).
  Tests: 419 pass / 0 fail, zero snapshot changes + new guard test. Single-run timing, minor tail
  contention with test suite (user≈wall, so minimal).

- **2026-07-24 — perf/combined (13 commits, all 3 branches): srj18 11/16 → 14/16 completed,
  1.66x aggregate speedup on common samples (1.21–1.82x/board), P50 118.7s → 84.2s** — quiet box,
  CI conditions (360s timeout, 16 workers), vs main v0.0.714 quiet baseline. Samples 2, 12, 14 now
  complete in CI budget; remaining timeouts: 6 (HD spin), 15 (borderline, completed at 454s under
  contention w/ 480s cap). Quality identical: srj18 drcPass 3=3; dataset01 85/85, 75/85 DRC pass,
  40.0 avgVia on every config. dataset01 total solve time -20% (458s → 366s).
  Attribution (run1, synchronized 5-way load): drc is the dominant lever (~25-35% on nearly ALL
  samples — full-board DRC eval was a hidden global tax, matching doesLineIntersectLine=24% in the
  CPU profile); astar consistent ~8-12%; hygiene ~1-3% (audit over-estimated the stats-rebuild cost —
  profile-first lesson); branches compose multiplicatively (sample 8: -16%/-31%/-5% → -47% combined).
  Method note: staggered run2 starts broke load symmetry → ±15%+ noise; synchronized run1 + quiet
  run are the trustworthy numbers.

## Accelerator decision (2026-07-24) — see perf-artifacts/kernel-inventory.md

- **cuDSS/cuSPARSE for MultiHeadPolyLine force relaxation: NO** (definitive). Pure exponential
  repulsion, no spring terms, not a gradient system (reaction split -f/2, not (t,1-t)); multiple
  equilibria are semantically load-bearing (candidates = homotopy classes, acceptance fires
  mid-relaxation). <=84 DOF, sub-microsecond dense on CPU, 2.5% of wall. Fix in TS SoA instead.
- **GPU offload: NOT YET JUSTIFIED.** The only offload-sized batch was the segment-distance family
  (~25% profile) driven by PcbConnectivityMap all-trace-pairs x all-segment-pairs inside
  checkTracesAreContiguous — i.e. DRC candidate scoring, which perf/drc-scoring ALREADY DELETED.
  Our biggest merged win was the GPU-shaped workload; that's why it gave ~30% globally.
  After merged+audited algorithmic fixes, no kernel's per-call batch beats pruned CPU-SoA over PCIe.
- **Worth building:** SoA SegmentTable (Float32Array ax/ay/bx/by/halfWidth + Int32Array layer/net/
  traceId) behind the repo-side DRC evaluator seam (lib/testing/getDrcErrors.ts) — hot code is in
  node_modules so the boundary must be repo-side. fp32 safe (~1e-4mm err vs 5e-3mm DRC epsilon);
  zero-thickness exact-intersection predicate needs fp64. cuSpatial pairwise_linestring_distance +
  quadtree join is a drop-in IF parallel candidate scoring later multiplies DRC eval counts.
- **Not worth accelerating:** HD A* probes (<=50 ops, sequential), union-find (fix as TS DSU; int-id
  interning is a marshaling prerequisite), A01/A03 + hypergraph pathing (sequential control flow).
  cuGraph/cuBLAS: no targets.
- **TODO before any kernel build: re-profile sample 8 on perf/combined** — the CPU profile in
  perf-artifacts/ predates the merged work, so residuals have reshuffled.

## Benchmark tiers (standing practice)

- Tier 0 (~1 min): `--sample-numbers 5` A/B + iteration-count/byte-identity check for result-identical claims.
- Tier 1 (~6-8 min): `--sample-numbers 5,8,10,6,12 --dataset 18` — fast/heavy/clean + both pathology classes.
- Tier 2 (full): 5-way synchronized gauntlet (perf-artifacts/gauntlet.sh) for attribution + pre-merge gates;
  quiet CI-condition run for headline numbers. Detach via setsid (survives session crashes).

## Pending measurement (implemented, tests green, awaiting benchmark gauntlet)

- `perf/astar-hotloop` (4 commits; 418 pass / 0 fail; zero snapshot diffs; **byte-identical sample-5
  output vs main, iterations 1048233 == 1048233** — provably result-identical): packed numeric A* node
  keys (getNodeKey was 3.1% CPU), neighbor objects built only after rejection, hoisted FutureCost
  invariants (getter→field, cached segments, per-node G/H memo), inline parent-chain via scan,
  hyperparameter class fields for hidden-class stability. Sanity timing sample 5: 55.7s → 49.2s
  (~12%, single run); peak RSS 3.59 GB → 1.17 GB (~3x less garbage).
- `perf/hygiene` (in progress): TinyHypergraph per-step stats rebuild (~4M iters), debug-flag gating
  (debugEnabled was hardcoded true in the HD A*), lazy repair visualize(), dead-code deletions,
  FlatbushIndex single-pass query, adjacency precompute, misc.

## Benchmark gauntlet plan

Sequential, quiet box: main ×2 → each branch ×2 (srj18 full) + dataset01 ×1 each → merge winners into
perf/combined → ×2 + full test suite → compare via perf-artifacts/compare-results.py.
Baseline (main, srj18): 11/16 completed, timeouts {2,6,12,14,15}, P50 118.7s.
Baseline (main, dataset01): 100% completed, 88.2% DRC pass, P50 3.2s, avg 40.04 vias.
