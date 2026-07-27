# Rust opportunities — evidence-ranked plan (2026-07-26)

Companion to REVIEW-2026-07-26.md. Every claim cites a measured result from this
campaign; nothing here is speculative architecture. TL;DR: **one Rust project is
justified by the data — the HD-stage portfolio on real threads. Kernel ports are
proven washes. Everything else waits for a profile.**

## 1. The justified project: portfolio-parallel HD solving on Rust threads

The campaign already ran the experiments that define this project's shape:

| Fact | Where measured |
|---|---|
| Aggregate candidate-work / winner-work R = **9.28** (sample 8, 1210 nodes) — the parallel work exists | parallelism-design.md §4 |
| P1 take-first race: **REJECTED** — winner selection is quality-load-bearing (0→15 DRC) | WINS 2026-07-24 |
| P2 deterministic schedule replay: winner semantics **SOLVED** (549/550 nodes exact) | parallelism-design.md §5 |
| P2 speed: **3.8x slower** (stage 1), **70% slower** (stage 2) — pure JS-worker transport cost; output hash-identical | WINS 2026-07-24/25 |
| Node-level parallelism (TS_PARALLEL_HD_NODES): works, **1.46x/1.82x**, but saturates at 4-8 workers because ONE node dominates (12.2s / 62.5s stragglers) | exp/rewrites f354b3c2 |
| Native kernel port of already-SoA code: bit-identical but a **wash** (JSC within 1.5-3x of native on typed arrays) | WINS 2026-07-24 (A01) |
| The SingleHighDensityRouteSolver family is object-heavy/megamorphic — "the shape Rust actually beats"; if native returns, "race with Rust THREADS not message passing" | HANDOFF final update |

The synthesis: **every ingredient of intra-node portfolio parallelism is proven
except an affordable transport, and threads + shared memory are exactly that.**
The JS failure was never semantics (replay solved it) — it was structured-clone
/ serialization per candidate per node. Rust threads share the node context
read-only at zero marshaling cost, and the replay selection is a pure function
of per-candidate trajectories (iterations, progress, solved/failed) that ports
directly.

Why this composes with (rather than duplicates) the landed HD-node parallelism:
node-level parallelism is ceiling-bound by straggler NODES (62.5s on sample 6 —
board-level 1.82x is AT that ceiling). The straggler node's ~75-100 candidates
run sequentially today. Candidate-level parallelism attacks the inside of the
straggler — the two multiply where it matters most.

**Blocker to resolve first:** CachedIntraNodeRouteSolver failure-cache
semantics (the 1-in-550 replay mismatch; staged as
perf-artifacts/pr-staging/issue-failure-cache.md). Options: per-thread caches +
accept the known 1/550-class divergence (quality-gate it), or fix/complete the
cache key upstream first.

**Bounded first step (about a week, kill-criteria included):**
1. cdylib + bun:ffi (recipe proven by the A01 port: stateful FFI, golden fnv1a
   hashing), flag `TS_NATIVE_PORTFOLIO`, sequential fallback intact.
2. Port the supervisor fitness schedule (g = iterations/MAX_ITERATIONS,
   h = 1-progress, MIN_SUBSTEPS=100 slices — parallelism-design.md has the
   cracked semantics incl. the four replay subtleties) + ONE candidate class to
   Rust threads (rayon or std). Serialize the node ONCE per node (the session
   protocol JS never got cheap).
3. Gate A: winner parity vs sequential on sample 8's full node corpus
   (549/550-style accounting; document every mismatch against the cache issue).
4. Gate B: HD-stage wall on samples 8/6, Tier-1 quality identical.
   **Continue only if parity holds AND HD-stage ≥1.3x at 8 threads.** Otherwise
   write the negative result in WINS.md and stop — the A01 wash showed how to
   stop cleanly.
5. Expansion order if gates pass: remaining candidate classes → GrowShrink
   inner loop → replace TS_PARALLEL_HD_NODES' worker pool with native threads
   (removes the JSON-over-SAB route marshaling entirely).

## 2. Proven non-targets (do not spend Rust effort here)

- **Typed-array kernels** (A01/A03 grids, math-utils scalar geometry): the A01
  experiment ended this — 1.65x kernel, wash overall, +5-10 vias on 3 samples.
  JSC is too good at monomorphic Float64Array loops for the FFI boundary to pay.
- **Batch geometry offload** (the K1 segment-distance family): the batch
  evaporated when perf/drc-scoring deleted the driver (kernel-inventory.md §2).
  Re-check only if parallel candidate scoring multiplies DRC evals again.
- **Whole-package rewrites for their own sake**: the meta-question was asked
  2026-07-24 ("rewrite all of tscircuit in rust?") — the org is ~50-100
  packages plus a browser runtime; the autorouter alone is 90k lines. The
  leverage is per-hot-subsystem, not per-repo.

## 3. Watchlist (decide after data lands)

- **tiny-hypergraph post-R1 residual**: after the compact-hop typed-array
  rewrite (OUR_TODOS G1) the stage's remaining cost is computeG arithmetic +
  blocker-search set algebra. If the stage still holds ≥10% of wall on the
  post-R1 profile, it becomes Rust candidate #2 — single sequential search, so
  plain kernel-port economics apply: port only if a micro-proof shows ≥2x.
- **Wavefront/negotiated-congestion router** (exp/rewrites 461e5f8a): the one
  genuinely GPU/Rust-shaped algorithm in the codebase (one shared cost field,
  embarrassingly parallel net expansion). Parked on quality (3x trace length,
  1854 vs 0 DRC), but if G6 eviction work ever grows into real global re-plan,
  a rayon Rust core is the right substrate and the CPU stepping stone to CUDA.
- **Route marshaling codec**: hdNodePool crosses routes as JSON-in-SAB. Fine at
  4-8 workers; if worker counts grow or boards get bigger, a compact binary
  codec (or the §1 native threads, which delete the boundary) is the fix.

## 4. Relationship to the Tenstorrent n300

The §1 experiment IS the cheap answer to the TT question. Wormhole's ~128 MIMD
Tensix cores (~1.5MB SRAM each) fit one intra-node candidate search per core —
the same independent-branchy-work hypothesis. If Rust threads on 64 x86 cores
can't beat the sequential supervisor with zero transport cost, tt-metal (with
real transport costs and a research-grade toolchain) certainly won't; if they
do, the TT port has a proven work model, a golden-output harness, and measured
speedup curves to beat. Keep TT exploratory until §1's gates report.

## GATE OUTCOMES (2026-07-27)

- **Gate A: PASSED.** native/portfolio-core (~7,700 LOC, 3 parallel port agents,
  compiled first-try) is bit-exact vs the TS solver: 1221 nodes, 76,923 candidates,
  0 winner / 0 candidate mismatches (6 golden records were torn-SAB capture artifacts,
  census-proven). Two systematic finds: engine Math.round ≠ floor(x+0.5) in the 1-ulp
  window; recorded budgets ToInt32-truncated by the replay transport.
- **Gate B: FAILED — negative result recorded (903b4be5), stopped per kill criteria.**
  HD-stage at 8 threads: 1.5-10.7x SLOWER. Run-to-completion semantics carry the full
  doomed-candidate cost the sequential schedule avoids; ~9x+ work multiplier swamps the
  threads. Port itself sound (~1.4x per-unit-work vs JSC, FFI minor). §1's premise
  "transport was the only killer" was HALF right — transport is indeed gone, but the
  P2 stage-1 work-multiplier lesson applied with full force.
- **If revisited**: in-process incremental replay early-exit (stage-2 semantics,
  hash-identical, ≤24/70 dispatch on 60% of nodes) is the one arithmetic that still
  works: ~9x → ~2-3x work × 8 threads × 1.4 kernel ≈ 4x. It is a fifth experiment,
  not a default.

## FINAL MEASUREMENT (2026-07-27, sequential native mode b8652bfc)

Schedule-identical sequential A/B (the clean kernel comparison): native-seq is
QUALITY-EXACT (s8 DRC 41=41, s5 0=0) and 1.58-1.73x SLOWER than TS - the Rust
engine runs this workload at ~0.6x of bun/JSC. The Gate-B-era "1.4x faster
per unit work" was an artifact of an assumed thread efficiency. Third
independent confirmation JSC wins on this code (A01 wash, run-to-completion
loss, schedule-identical loss): the campaign's own JIT-friendliness rounds
(hidden classes, SoA pools, numeric keys) removed the headroom a native port
would have exploited. Stage-2-threads arithmetic re-done with the measured
kernel: 8 threads / ~2.5x early-exit work x 0.6 ≈ 1.9x theoretical - now
resting entirely on an unproven work-reduction estimate, against four
consecutive negative parallel results. RECOMMENDATION: do not build stage-2;
the Rust chapter closes with a bit-exact mirror + parity harness as the
permanent artifacts. The living speed frontier remains TS-side: HD-node
workers (landed, 1.5-1.8x), G6 eviction+re-path, upstream PRs. This also
answers Tenstorrent: if zero-transport native threads lose to the JS
scheduler on this hardware, an accelerator port is not the next move -
algorithmic work (G6) is.
