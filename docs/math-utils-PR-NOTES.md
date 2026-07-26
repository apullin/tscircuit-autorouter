# PR notes — @tscircuit/math-utils (untracked scratch, not for commit)

Repo: `~/personal/math-utils-fix`, based on `origin/main` = `cadf0e5` (v0.0.36),
verified to be both the upstream tip and the published npm latest at the time of
writing (`npm view @tscircuit/math-utils version` → 0.0.36).

Two independent branches, each self-contained and green on all three upstream CI
checks (`bun test`, `bunx tsc --noEmit`, `bun run format:check`).

---

## PR 1 — branch `bugfix/orientation-collinear-robustness` (correctness, 1 commit)

**Title:** Fix colinear segments being reported as intersecting

**Body:**

`orientation()` compares the cross product against exactly `0`. For colinear
input the true cross product *is* 0, so the computed value is pure
floating-point cancellation dust whose **sign is meaningless** — and
`doSegmentsIntersect()` then trusts that sign in its general case
(`o1 !== o2 && o3 !== o4`) and reports the segments as intersecting.

Reproduction on current `main` (coordinates captured from a real PCB autoroute;
both segments lie exactly on `y = x - 19.2`, 0.424mm apart):

```ts
const a1 = { x: 19.45000000000001, y: 0.25 }
const a2 = { x: 19.35000000000001, y: 0.15 }
const b1 = { x: 18.950000000000003, y: -0.25 }
const b2 = { x: 19.050000000000004, y: -0.15 }

doSegmentsIntersect(a1, a2, b1, b2)        // true   (expected false)
segmentToSegmentMinDistance(a1, a2, b1, b2) // 0     (expected 0.4243)
```

The four cross products evaluate to `0, 3.469e-18, 0, 3.469e-18` → classified
`0, 1, 0, 1` → "intersecting".

**Why it matters beyond this function:** every clearance check built on the
predicate inherits the false zero. `@tscircuit/checks` computes
`gap = segmentToSegmentMinDistance(a, b) - thicknessA/2 - thicknessB/2` for
`pcb_trace_clearance_error`, so a false 0 becomes a false clearance violation.
Colinear geometry is the common case on PCBs (traces sharing a 45°/90° line).

**Fix:** treat `|cross|` within a relative tolerance of the operand magnitude as
colinear (1e-12 — about four orders of magnitude above double cancellation error
and far below any geometrically meaningful area). Disjoint colinear segments then
fall through to the existing `onSegment()` bounding-box checks, which reject them
correctly.

**Tests:** `tests/colinear-robustness.test.ts`, 11 cases — the captured
coordinates, dust classification, and preservation of genuine crossings,
T-junctions, shared endpoints, overlapping colinear segments and shallow-angle
crossings. 3 fail before the change; suite is 138/138 after.

---

## PR 2 — branch `perf/parametric-segment-distance` (performance, 2 commits on top of PR 1)

> **BRANCH CORRECTION (2026-07-26 review):** submit this PR from
> `perf/parametric-segment-distance` (d3de325 = the two perf commits stacked ON
> the PR-1 fix; 140/140 tests; its tree byte-matches the dist that every
> downstream measurement used). Do NOT use `perf/geometry-hot-path` (4dbd011):
> it carries the same two perf commits but is based directly on v0.0.36 and
> **lacks the collinearity fix and its regression tests** — merging it alone
> would reintroduce the PR-1 bug. Mark PR 2 as stacked on PR 1 (it contains
> PR 1's commit; rebase-merge PR 1 first and PR 2 reduces to the two perf
> commits).

**Title:** Remove per-call allocations and use a parametric solve for segment distance

**Body:**

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

---

## Reproducing the measurements

```bash
cd ~/personal/math-utils-fix && bun test && bunx tsc --noEmit && bun run format:check
# downstream A/B (autorouter checkout at ~/personal/awt-r3):
/tmp/ab-mathutils.sh          # 2x2 interleaved, sample 6
/tmp/tier1-mu.sh              # 5-board tier-1 with DRC/via parity
# /tmp is volatile; durable copies of both scripts:
#   ~/personal/tscircuit-autorouter/perf-artifacts/tmp-rescue-2026-07-26/
```

Prebuilt dists for both arms are archived at
`~/personal/awt-r3/perf-artifacts/math-utils-fix/`.
