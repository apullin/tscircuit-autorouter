> **Stacked on #<PR1-number>** — this branch contains that fix commit plus the two
> perf commits; merge the fix PR first and this reduces to the two perf commits.

Profiling a dense PCB autoroute (`@tscircuit/capacity-autorouter`, srj18 sample
6, 352s wall) put ~22% of *total program wall time* inside these helpers:
`pointToSegmentDistance` 14.5%, `orientation` 4.4%, `doSegmentsIntersect` 1.7%,
`segmentToSegmentMinDistance` 1.5%.

Commit 1 — allocation removal, **bit-for-bit identical results**:
- `pointToSegmentDistance` no longer allocates a projection object.
- `segmentToSegmentMinDistance` / `segmentsDistance` no longer build a
  4-element array and call `Math.min(...spread)`.
- `tests/geometry-hot-path-identity.test.ts` pins identity with 40k randomized
  cases (PCB-scale, degenerate and colinear configurations) via `Object.is`.
- Microbenchmark: `segmentToSegmentMinDistance` 138.0ns → 71.3ns (1.94x).

Commit 2 — closest-point parametric solve (Ericson, *Real-Time Collision
Detection* 5.1.9) for `segmentToSegmentMinDistance`: one sqrt and no
intersection predicate, replacing four point-to-segment distances (four sqrts)
plus four orientation tests.
- Microbenchmark: 134.7ns → 27.3ns (**4.93x**).
- Intersecting segments still return exactly 0: when the computed gap is below
  1e-9mm the exact predicate is consulted (rare path).
- Results are no longer bit-identical — this is a shorter computation with fewer
  roundings, so it can differ in the last ulp. The identity test asserts
  agreement to 1e-12 relative over 20k randomized configurations.

**Downstream validation** (tscircuit-autorouter, srj18 dataset, 64-core x86,
bun 1.3.14), upstream v0.0.36 vs this branch:

| sample | before | after | speedup | DRC errors | vias |
|-------:|-------:|------:|--------:|-----------:|-----:|
| 5  | 23.3s  | 22.1s  | 1.05x | 0 → 0   | 151 → 151 |
| 8  | 115.6s | 110.9s | 1.04x | 45 → 45 | 290 → 290 |
| 10 | 63.7s  | 60.4s  | 1.06x | 0 → 0   | 176 → 176 |
| 6  | 319.5s | 265.0s | **1.21x** | 99 → 99 | 290 → 290 |
| 12 | 163.1s | 162.6s | 1.00x | 11 → 11 | 323 → 323 |
| **total** | **685.3s** | **620.9s** | **1.10x** | identical | identical |

Completion rate 100% both, relaxed-DRC rate 40.0% both, avgVia 246 both,
P95 288.2s → 244.5s. A dedicated 2×2 interleaved A/B on sample 6 gave
344s → 279.5s with an *identical* solver iteration count (2,981,684), i.e. the
routing decisions are unchanged.

If the last-ulp change is unwelcome, commit 1 alone is bit-identical and still
worth ~9.7% on that board (344s → 310.5s).
