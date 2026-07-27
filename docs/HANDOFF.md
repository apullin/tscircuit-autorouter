# HANDOFF — tscircuit autorouter performance work (2026-07-23/24)

> **2026-07-27 UPDATE — TS frontier advanced on both tracks; Rust chapter closed by the
> user.** (1) **G9 HD-node + A2 parallelism PRODUCTIZED** on perf-ts-stack (42d12713,
> 83f46ea8): auto-enable off-benchmark/off-browser with hardware/memory/board-size
> gates (explicit env always wins; benchmark.sh pins both to 0), full bookkeeping
> parity on the parallel path, worker-side success-only intra-node cache (failure-cache
> poisoning class closed worker-side). Gates: s5 anchor 1053687 exact under
> TS_BENCHMARK=1; s8 sequential 1973601 exact DRC 41; s8 auto-enabled DRC 41==41 at
> ~1.5x wall. Remaining for users on Node/browser: G7 runtime port.
> (2) **G6 eviction+re-path: built, measured, PARKED negative-for-speed** (be0798ac).
> The mechanism works (6/6 planned evictions rescued; over-commitment confirmed on
> both boards) but rescue economics lose to growth: trimmed nodes are MARGINALLY
> routable (near-exhaustion searches) while growth makes nodes EASY. s8 g=0: +8%
> iterations/+3 DRC rejected; s6 g=1: DRC 96 vs 100 but +16% iterations rejected.
> Machinery kept flag-off as the repair valve. **The remaining algorithmic lever is
> capacity-model prevention (G10 in OUR_TODOS)**: getTunedTotalCapacity1 is tuned for
> 2 layers on 4-layer boards; calibration data ready (PERF_NODE_DUMP labels, eviction
> stats, growth-ladder corpus data). Full evidence: WINS.md 2026-07-27 entry +
> perf-artifacts/g6-eviction-design.md epilogue. Rust: user closed it after the final
> honest measurement (native seq 0.6x JSC) — the perf frontier is TS-side.

> **CONSOLIDATION UPDATE (2026-07-26)** — a second-opinion review session (Claude Code /
> Fable 5) audited the whole campaign and then consolidated it. Read these in order:
> **REVIEW-2026-07-26.md** (findings: A2 pool bug fixed, hypot patch was dormant, stack
> was not self-contained, exp/rewrites results unrecorded), **WINS.md** top entry
> (what was verified/measured on 2026-07-26), **RUST-PLAN.md** (evidence-ranked native
> plan), **PR-STAGING.md** (3 upstream PRs + 3 issues, one command each, awaiting user
> trigger). Current state: perf-ts-stack = v0.0.718 + 46 commits, self-contained
> patchedDependencies + perf-patches/ (identity-safe tier, hypot quality-gated tier,
> round-5 tier), TS_PARALLEL_A2 + TS_PARALLEL_HD_NODES both landed default-off and
> parity-gated. **Sample-5 identity anchor is now 1053687 iterations** (hypot activation
> legally moved it from 1048233); sample-8 anchor 1973601. The 2 suite failures
> (bugreport36, dip16) are upstream v0.0.714→717 drift — do not "fix" them locally.

> **UPSTREAM DEPENDENCY UPDATE (2026-07-24, latest)** — the largest remaining lever was NOT in this
> repo. A fresh CPU profile of the tail board (srj18 sample 6, 352s) attributes **24% of total wall
> to @tscircuit/math-utils** (`pointToSegmentDistance` 14.5% alone), versus 19% for the repo's HD A*
> family and 12% for A01. Two PR-ready branches now live in `~/personal/math-utils-fix` (based on
> origin/main = npm latest v0.0.36; see its PR-NOTES.md):
> (1) a **correctness bug** — `orientation()` tested the cross product against exactly 0, so colinear
> input let meaningless cancellation dust drive `doSegmentsIntersect` into its "general case";
> disjoint colinear segments 0.424mm apart are reported as intersecting and
> `segmentToSegmentMinDistance` returns 0. @tscircuit/checks derives `pcb_trace_clearance_error`
> from that number, so it can manufacture false DRC violations. Verified against a pristine
> checkout of the published tip.
> (2) **perf** — allocation removal (bit-identical, 1.94x) plus the clamped parametric closest-point
> solve (4.93x on the function).
> Measured downstream: Tier-1 (5,8,10,6,12) 685.3s → 620.9s (**1.10x**), sample 6 344s → 279.5s
> (**1.21x**), with **identical iteration counts, DRC counts and via counts** on every board.
> Also measured and parked: TS_NODE_WORK_CAP (87.6% of sample-6 HD candidate work goes to the 41
> nodes that fail anyway, but capping it only buys ~10% because those are cheap iterations); the
> flatbush per-neighbour query hoist (identity-preserving version is a wash; it did expose the
> collinear bug above). Next measured candidate: `getSegmentBoardClearance` in high-density-repair03
> scans every board-outline edge per trace segment with no bbox reject — 50k profile samples (~14%
> of sample 6) before the math-utils fix.

> **FINAL CAMPAIGN UPDATE (2026-07-24)** — branch perf/ts-round3 (fork: perf-round3), through 80d40a7b.
> Shipped and live: rounds 1-6 TS optimizations (2.34x aggregate on 11 common srj18 samples,
> 16/16 vs 11/16 completed, quality parity exact) + A2 parallel DRC (bit-identical, sample 6 -42s).
> Measured-to-verdict and PARKED: native A01 Rust kernel (bit-identical, 1.65x kernel, wash
> overall — typed-array TS is within 1.5-3x of native, don't port hand-tuned kernels);
> P2 replay stages 1+2 (winner-identical, 70% slower — message passing never pays at node
> granularity); lean/dominant portfolios (rejected — the hard tail needs full search diversity);
> B2 progress fix (rejected — 12% slower). What remains: B1 sample-6 stagnation (algorithmic
> research), the intra-node failure-cache key-completeness question (potential upstream bug),
> and upstreaming the shipped work. If native is revisited: port the repo's
> SingleHighDensityRouteSolver family (object-heavy, megamorphic — the shape Rust actually
> beats), not typed-array kernels, and race with Rust THREADS not message passing.

> **NIGHT UPDATE (2026-07-24, latest)** — branch perf/ts-round3 (fork: perf-round3), commits through
> 5e0e46ac. **Round 5: A01 SoA node pool = +4.3% on sample 8 (interleaved A/B), bit-identical, shipped.**
> Parallelism: R=9.28 measured (work exists) but P1 take-first race REJECTED (slower + 15 DRC errors
> vs 0 — winner selection is quality-load-bearing); P2 blocked on B2, and the B2 fix itself was
> REJECTED (progress-aware scheduling is 12% slower on samples 10/12). Parallelism PARKED pending a
> better progress metric + session protocol — full analysis in perf-artifacts/parallelism-design.md.
> **Benchmark hygiene: another project (klayout PGO builds) now uses this box — load ~12 corrupted
> sequential benchmark comparisons overnight. ALWAYS interleave A/B runs (alternating configs) when
> the box isn't quiet; check `uptime` first.** Next safe items: ensureSharedNodeCosts/
> getClosestFutureConnectionPoint (3.3% total, future-point spatial index), tiny-hypergraph
> computeG residual arithmetic (6.7% self), B7 pointToBoxDistance scalar (~0.5%), C7b flatbush
> query pruning. Then the big rocks need design, not edits: P2 parallelism, B1 sample-6 stagnation.
> Box quiet again (load 1.15). Full gauntlet (srj18 ×16 + dataset01 ×85) on round-6 state:
> perf-artifacts/full-srj18-round6.json + full-dataset01-round6.json.
> **GAUNTLET: srj18 16/16 completed (main 11/16), P50 63.3s (main 118.7s), quality parity exact.**
> Explored-bitmap experiment: neutral (0.99x), reverted. A2 branch portfolio verified VIABLE and
> potentially bit-identical (broad derives from input, not baseline output — selection is data-only);
> see perf-artifacts/parallelism-design.md §A2. Night totals on branch: rounds 4-6 shipped
> (+4.3% s8 SoA, +1.5% s8 rejects/scalar, +2-8% r4), 2 reverts (memo, bitmap), 2 rejected
> experiments (P1 race, B2 fix) — all documented with data.

> **ROUND 4 UPDATE (2026-07-24, latest)** — branch perf/ts-round3 (pushed to fork as perf-round3),
> commits through 6deca9b9. **Tier-1 vs round-3 (quiet box, 360s cap): +2.0-8.1% per sample
> (s8 1.026x, s10 1.065x, s12 1.081x, s5 1.020x, s6 1.029x), 5/5 complete, quality identical.**
> Tests 419/0; identity (iterations 1048233 on sample 5) preserved at every step.
> **C7 memo lesson: 85.9% probe CALL redundancy ≠ time saved — string-key memo regressed sample 8
> by 11%; reverted. Measure TIME of redundant work before memoizing.** Kept: determineOwnerPair
> WeakMap index, net-id hoisting round 2, TraceSimplification pre-filter, getRelaxedSearchHops 1.93x
> micro. Parallelism design doc: perf-artifacts/parallelism-design.md (P1 race recommended; measure
> supervisor work-ratio R first; A2 branch independence unverified). Next safe items: A01 stepOnce
> self-time (7.6%), math-utils scalar kernels (~4%), C7b flatbush query pruning (different attack).
> Memory finding: sample-5 peak RSS 1.19GB but only 0.37GB retained — ~70% GC-pacing garbage;
> periodic Bun.gc() buys 0.1-0.3GB at 6-39% wall — bad trade; allocation-rate reduction is the lever.

> **ROUND 3 UPDATE (2026-07-24, latest)** — `perf/ts-round3` = ts-round2 + repo lib commit dd48f5f1 +
> 9 dependency patch files (perf-patches/, applied live in awt-ts2/awt-r3 node_modules).
> **Tier-1 A/B vs ts-round2 (quiet box, 360s cap, 2 runs): 1.25-1.32x on heavy samples (s8 1.32x,
> s10/s12 1.26x, s5 1.04x), SAMPLE 6 NOW COMPLETES (323.7s / 342.6s vs timeout — borderline vs cap),
> quality metrics identical on every sample.** Tests 419/0. All remaining changes result-identical.
> Round-3 baseline data proved ts-round2 (prev. unbenchmarked): Tier-1 P50 121.4s, 4/5 completed.
> **Two hard lessons, read before touching node_modules or Math.hypot:**
> 1. bun HARDLINKS node_modules into ~/.bun/install/cache + every worktree. In-place edits contaminate
>    everything. Apply dep changes with `patch` (breaks the link) or rm+cp first; never edit in place.
>    Pristine refs: /tmp/checks-r3/*-orig.js (npm), ~/.bun/install/cache/@GH@* (git deps, verified clean).
> 2. Math.hypot→sqrt in tiny-hypergraph A* cost functions flips tie-breaks on real boards (3 SVG
>    snapshot tests failed) despite synthetic-config identity. REVERTED. Only revisit as a
>    quality-gated experiment with snapshot updates (OUR_TODOS B6).
> Fresh post-round-2 profile: awt-ts2/perf-artifacts/r3-prof/ (sample 8, 186s). Open residuals:
> flatbush search ~3.8% (cross-candidate obstacle-clearance memo, OUR_TODOS C7), CapacityPathing
> sort/shift heap (B4), union-find DSU (B5/D1), computeProgress NaN (B2), then parallelism (A1/A2).
> Worktrees: awt-r3 = perf/ts-round3 (patched deps via symlink to awt-ts2); awt-r3base = DETACHED
> ts-round2 with PRISTINE deps (benchmark baseline; sharp manually built there). All other worktrees
> + main repo node_modules verified pristine after the hardlink incident.


Self-contained context dump for a fresh reader or second-opinion review.
Companion docs: `WINS.md` (measured results), `OUR_TODOS.md` (idea list),
`perf-audit-2026-07-23.md` (all findings), `perf-artifacts/kernel-inventory.md` (accelerator analysis).
All of these are untracked/gitignored and exist only on this machine.

## 1. The project and the goal

`tscircuit` is a React/TypeScript EDA toolchain (circuits as code → Circuit JSON → PCB/schematic/gerber).
The PCB autorouter lives in a separate repo: `github.com/tscircuit/tscircuit-autorouter`
(npm `@tscircuit/capacity-autorouter`), ~90k lines of pure TypeScript across 377 files in `lib/`,
running single-threaded per board on Bun. It also ships to browsers, hence the React debug UI.

Goal: make the solver faster. Long-horizon interest in GPU (CUDA) or Tenstorrent Wormhole acceleration,
but explicitly downstream of extracting what we can from TypeScript + CPU parallelism.

## 2. Architecture in one paragraph

Everything is a `BaseSolver` subclass (`lib/solvers/BaseSolver.ts`) — an iterative micro-step design where
each solver implements `_step()` and is pumped until `solved`/`failed`, with `MAX_ITERATIONS` budgets, per-stage
stats and visualization hooks (built for their interactive debugger). The production pipeline
`AutoroutingPipelineSolver7_MultiGraph` (~1100 lines) chains ~20 staged sub-solvers: preprocessing →
component/BGA detection → escape-via placement → multi-graph topology planning → node subdivision →
hypergraph port-point pathing → **HighDensitySolver** (detailed routing) → force-improve/repair →
trace simplification → length matching → trace width → two exact-geometry DRC repair stages.
Data structures are hand-rolled JS (binary heap, spatial hash, Flatbush/rbush). No threads, no WASM in the
production path (`@tscircuit/krt-wasm` exists only as a comparison pipeline).

## 3. Environment (this machine)

- 64 threads, 123 GB RAM. Had NO JS runtime; installed user-local: bun 1.3.14 (`~/.bun/bin`),
  Node 24.13.0 + npm (`~/.local/node-v24.13.0-linux-x64`, symlinked into `~/.local/bin`).
  Non-interactive shells need `PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"`.
- **HARD LIMIT: 8 concurrent bun workers.** More causes OOM — a session was crash-killed on 2026-07-24 by
  32 test workers + 5 concurrent benchmarks. A single solve can hold a GB-scale heap (main peaked at
  3.59 GB RSS on srj18 sample 5; the astar allocation fixes cut it to 1.17 GB). **Memory, not core count,
  is the binding constraint — never scale bun concurrency by `nproc`.** When multiple agents share the box,
  budget 8 TOTAL across all of them. Detach long runs with `setsid` so a crash doesn't kill them.
- Tests: `bun test --parallel=8 --timeout 300000` → 418 pass / 0 fail / 55 skip
  (bun 1.3's built-in `--parallel`; the sequential default takes 30+ min. Their CI shards across 5 runners).
- Benchmarks: `./benchmark.sh [--dataset 18] [--sample-numbers ...] [--concurrency N] [--sample-timeout 480s]`.
  Datasets are git-hosted deps. srj18 = 16 Arduino/ant-micro boards = the hard corpus. dataset01 = 85 easy boards.
- Profiling: `bun --cpu-prof --cpu-prof-md scripts/run-sample.ts --pipeline 7 --dataset srj18 --sample N`;
  stage-level: `bun scripts/profile-solvers.ts --dataset 18`.

## 4. Baselines (main @ v0.0.714, quiet box, CI conditions)

- srj18: **11/16 completed**, timeouts {2,6,12,14,15}, P50 118.7s. Matches their CI exactly.
- dataset01: 85/85 completed, 75/85 relaxed-DRC pass (88.2%), P50 3.2s, avg 40.04 vias.
- Stage split on srj18 completers: **HighDensitySolver ~58%, TinyHypergraphPortPointPathing ~30%**,
  trace simplification ~10%. Exact-geometry DRC ≈ 0 on healthy boards but killed samples 2 and 12.
- Function-level (sample 8, 365s): ~25% of ALL CPU was segment geometry in *dependency* packages
  (`doesLineIntersectLine` 24% total, `segmentsDistance` ~14% self) — DRC/connectivity, not routing.
  `getNodeKey` string-building 3.1% self. Native `map/filter/some/find/Set/cloneObject` ≈ 10-15% (allocation tax).

## 5. What we changed and what it bought

Branch `perf/combined` = 13 commits, merged from three isolated branches. Pushed to
`github.com/apullin/tscircuit-autorouter` as branch `perf` (+ `perf-hygiene`, `perf-astar-hotloop`,
`perf-drc-scoring`).

**Result (quiet box, CI conditions, vs main): srj18 11/16 → 14/16 completed, 1.66x aggregate speedup on
common samples (1.21-1.82x per board), P50 118.7s → 84.2s. Quality identical** (srj18 DRC-pass 3=3;
dataset01 85/85, 75/85, 40.0 vias on every config). dataset01 total solve time -20%.

Attribution from a 5-way *simultaneous* benchmark (identical ambient load):
- `perf/drc-scoring` (1 commit) — **dominant, ~25-35% on nearly ALL samples.** Repair-candidate scoring
  was re-running FULL-BOARD DRC per candidate, including an O(T²·p²) trace-contiguity check that repair
  moves cannot fix. Fix: scoring-variant evaluator (contiguity excluded from scoring only, still strict for
  final/reported results), connectivity-map base partition cached, scaffold elements memoized.
  Sample 12 went from timeout (23 iters/~300s) to completing (41 iters/55.7s in that stage).
- `perf/astar-hotloop` (4 commits) — ~8-12%, **provably result-identical** (byte-identical output SRJ and
  identical iteration count 1,048,233 on sample 5). Packed numeric A* node keys replacing float-formatted
  strings, neighbor objects constructed only after rejection tests, hoisted invariants, inline parent-chain
  via scan, hyperparameter class fields for hidden-class stability. Peak RSS 3.59 GB → 1.17 GB.
- `perf/hygiene` (8 commits) — ~1-3% only. Per-micro-step stats rebuild gating, debug-flag gating
  (`debugEnabled` was hardcoded `true` in the HD A*), lazy repair `visualize()`, two verified dead
  computations deleted from the hottest loops, Flatbush/getNodeEdgeMap allocations, adjacency precompute,
  portfolio budget caching, flatbush-default fix.

Branch `perf/ts-round2` (4 commits, stacked on `perf/combined`, tests pending at handoff time, NOT
benchmarked): O(N) tiny-hypergraph handoff (was O(N²) `computeNodePf` calling full `getOutput()` per node)
and stage-entry Map lookups; polyline force-loop per-pair rebuild hoisting; objectHash/structuredClone
removal from the intra-node cache path; numeric keys + stamp dedupe + bucket membership in the HD route
spatial index.

## 6. Decisions made (and the reasoning, for challenge)

- **cuDSS/cuSPARSE for the MultiHeadPolyLine force-relaxation solver: NO.** Read the force code in full —
  pure exponential repulsion with no spring terms, piecewise closest-point projections, 4x force switching
  inside via radius, hard boundary clamps, reaction forces split −f/2 (not the (t,1−t) gradient split, so it
  isn't a gradient system). Multiple equilibria are semantically load-bearing (candidates = homotopy classes;
  acceptance fires mid-relaxation). ≤84 DOF, sub-microsecond dense on CPU, 2.5% of wall.
- **GPU offload: not yet justified.** The only offload-sized batch was the segment-distance family
  (~25% of the profile), and it was driven by contiguity checking inside DRC candidate scoring — which
  `perf/drc-scoring` already deleted. i.e. our biggest merged win *was* the GPU-shaped workload.
  After the algorithmic fixes, no kernel retains a per-call batch that beats a pruned CPU-SoA implementation
  over PCIe. Revisit if parallel candidate scoring multiplies DRC eval counts back up (cuSpatial
  `pairwise_linestring_distance` + quadtree join would be a drop-in shape).
- **No TS→PTX path exists**; any native/GPU backend is reached via the C ABI (`bun:ffi` or N-API).
  Recommended first native step if/when needed: **Rust** (napi-rs or cdylib+FFI), not CUDA — no driver
  coupling, portable CI, easy SIMD, a tenth the friction.

## 7. The main open hypothesis (highest leverage, unbuilt)

**The compute is coarse-grained task-parallel speculative search, not fine-grained data-parallel math.**
`PortfolioSingleIntraNodeSolver` runs ~60 independent candidate solvers per node (different hyperparameters,
only the winner kept); `GlobalDrcBranchPortfolioSolver` runs 3 independent branches; ~2000 intra-node solves
per board at ms-to-seconds each.

Key claim worth reviewing: **`HyperParameterSupervisorSolver`'s adaptive time-slicing exists to ration ONE
core.** With 64 cores that rationing is counterproductive — run all candidates concurrently and take the
first/best success, converting adaptive scheduling into a race. This would be a case where parallel hardware
makes an algorithmic layer unnecessary rather than merely faster.

Caveats we know about: (a) NOT result-identical — must be gated on benchmark quality, not snapshots;
(b) Amdahl — HD is ~58% of wall, so even 8x there is ~2x overall before the sequential ~30% hypergraph
pathing stage becomes the wall; (c) node-level parallelism is harder than portfolio-level because solved
routes constrain later nodes (`getFirstSolvedViaTraceConflict`).

Strategic note: CPU parallelism answers the same "is there enough independent branchy work?" question that a
Tenstorrent bet depends on — for free, on hardware already owned. Wormhole's ~128 MIMD Tensix cores with
~1.5MB local SRAM each suit independent small searches in a way CUDA's SIMT warps do not.

## 8. Known-unfixed issues (deliberate)

- **Sample 6** — the remaining hard srj18 timeout. HighDensitySolver spins ~1M iterations at 0% progress.
  Algorithmic (stagnation detection/escalation), not micro-optimization.
- **`computeProgress` returns NaN** in `SingleHighDensityRouteSolver` — `BaseSolver.step()` calls it with no
  args → `Math.atan(NaN)` → NaN → masked downstream by `progress || 0`. The portfolio's fitness scheduler
  therefore never sees true single-route progress. Left unfixed on purpose (changes scheduling); likely
  interacts with sample 6 and with the parallel-portfolio idea.
- Substantial hot code is upstream and untouched: `circuit-json-to-connectivity-map` (quadratic union-find;
  all-trace-pairs × all-segment-pairs connectivity build), `@tscircuit/checks` (`checkViaTraceClearance`
  O(V×S) with no spatial index though its sibling has one; O(V²) via spacing twice;
  `getReadableNameForPcbTrace` linear-scanning the whole soup per trace regardless of errors),
  `high-density-repair03` (full-board DRC per candidate — we only fixed the repo-side scoring seam),
  `@tscircuit/high-density-a01`.

## 9. Things a reviewer should be skeptical about

1. The 1.66x headline is **one quiet run per config**. Repeats existed only under concurrent load, where
   staggered start times broke load symmetry and produced ±15%+ noise. The per-sample direction is
   consistent and the completion-count change is categorical, but the exact multiplier is soft.
2. `perf/drc-scoring` **changes solver behavior** (repair decisions differ). It passed the full test suite
   with zero snapshot changes and identical DRC-pass counts on both corpora, but "scoring no longer sees
   contiguity errors" is a real semantic change; a repair move that *created* a contiguity problem would go
   unpenalized during scoring (mitigated by endpoint-preservation constraints; final eval still reports it).
3. The result-identity claims for `perf/astar-hotloop` rest on byte-identical output for **one** sample plus
   the full test suite — heavier samples were not diffed.
4. The audit's cost predictions were **wrong in both directions**: the TinyHypergraph per-step stats rebuild
   was predicted to be the cheapest big win and delivered ~2%; the DRC scoring change was billed as a
   timeout-only fix and delivered ~30% globally. Read-the-code estimates need profile/benchmark confirmation.
5. The CPU profile in `perf-artifacts/` **predates** all merged work; residuals have certainly reshuffled.
   A re-profile of sample 8 on `perf/combined` is queued but not yet done — do it before any kernel work.
6. Benchmarks with `--sample-timeout 480s` differ from CI's 360s: samples 14/15 "complete" under the
   relaxed cap in some configs. Always compare like-for-like caps.
