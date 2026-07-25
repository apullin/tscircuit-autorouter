# tscircuit autorouter performance campaign — evidence bundle

Backup of work that otherwise existed only on one workstation. Pushed to
`apullin/tscircuit-autorouter` branch `perf-notes` (unrelated history — notes only,
no source). The code itself is on branch `perf-round3`.

## Headline (measured 2026-07-25, 64-core x86, bun 1.3.14)

Versus upstream `main` @ v0.0.714, like-for-like (benchmark harness, concurrency 8,
360s per-sample cap):

| corpus | boards | aggregate speedup | median per board | completion |
|---|---|---|---|---|
| srj18 (hard) | 16 | **2.40x** | 2.28x (1.58–3.02x) | 11/16 → **16/16** |
| dataset01 (typical) | 85 | **2.26x** | 2.59x (p10 1.94x, p90 3.98x) | 100% → 100% |

Quality: DRC error counts and via counts identical to main board-for-board
(11/11 comparable srj18 boards; identical avgVia across all 85 dataset01 boards).

Peak memory (`/usr/bin/time -f %M`, one process at a time):

| sample | main | current | change |
|---|---|---|---|
| 5 | 3959 MB | 2730 MB | −31% |
| 8 | 2421 MB | 2001 MB | −17% |
| 6 | ≥9613 MB (killed at 420s, unfinished) | 3310 MB | **−66%** |

## What shipped vs what was rejected

Shipped: six rounds of TS optimization (SoA node pool, DRC scoring variant, hidden-class
stability, spatial-index and hot-loop work, dead-code removal) + A2 parallel DRC branch
portfolio (bit-identical) + the upstream `@tscircuit/math-utils` fixes.

Rejected with data (see `docs/WINS.md`, `docs/parallelism-design.md`):
- Native A01 kernel in Rust — bit-identical, 1.65x on the kernel, **wash** end-to-end.
- P1 take-first portfolio race — slower *and* 15 DRC errors vs 0.
- P2 deterministic replay (both stages) — winner-identical, 70% slower; transport-bound.
- B2 progress-metric fix — 12% slower.
- Lean/dominant portfolios — the hard tail needs full search diversity (+46% on sample 8).
- Flatbush per-neighbour query hoist — identity-preserving version is a wash.

## Upstream dependency work

`@tscircuit/math-utils` (branches on `apullin/math-utils`, base = origin/main = npm latest v0.0.36):
- `fix/orientation-collinear-robustness` — **correctness**: colinear input let float
  cancellation dust drive `doSegmentsIntersect` into its general case, so disjoint colinear
  segments were "intersecting" and `segmentToSegmentMinDistance` returned 0 for segments
  0.424mm apart. Reaches DRC via `@tscircuit/checks` `pcb_trace_clearance_error`.
- `perf/geometry-hot-path` — allocation removal (bit-identical, 1.94x) plus the clamped
  parametric closest-point solve (4.93x).
Full PR bodies with measurements: `docs/math-utils-PR-NOTES.md`.

## Layout

- `docs/` — HANDOFF (start here), WINS (measured results), OUR_TODOS (idea list),
  perf-audit (original findings), kernel-inventory + parallelism-design (accelerator and
  concurrency analysis), math-utils PR notes.
- `results/` — benchmark JSON for every run referenced above, including the `main`
  baselines (`main-*.json`, `mainquiet-*.json`), round-6 state (`full-*-round6.json`),
  the math-utils A/B (`tier1-orig.json` / `tier1-parametric.json`) and the final
  cumulative run (`cumulative-srj18-2026-07-25.json`).
- `harnesses/` — the A/B and measurement scripts. They hardcode absolute paths under
  `/home/pullin/personal/` (worktrees `awt-r3` = perf branch, `tscircuit-autorouter` = main).

## Reproduction notes learned the hard way

1. **Always interleave A/B runs.** Sequential before/after comparisons on a shared box got
   corrupted by another project's load overnight.
2. **Benchmark concurrency changes the answer.** The same math-utils change measures 1.21x
   solo on sample 6, 1.18x inside an 8-way gauntlet, and 1.03x averaged over 16 boards.
   State the concurrency with any number.
3. **Never `cp` into a `node_modules` package to patch it.** bun hardlinks packages from its
   global cache, so writing through the link mutates the cache and every other checkout.
   Use `rm -rf dist && cp -r <new> dist`.
4. **Memory, not cores, is the binding constraint** for parallel benchmarking on this box.
