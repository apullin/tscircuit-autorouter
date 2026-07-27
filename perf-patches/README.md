# perf-patches — dependency modifications (round 3, 2026-07-24; math-utils added 2026-07-26)

Unified diffs against the PRISTINE dependency sources, one file per package,
paths relative to the package root (`-p1` inside the package dir).
These are the durable record of the round-3 node_modules edits (applied and
benchmarked in ~/personal/awt-ts2/node_modules, shared by ~/personal/awt-r3
via symlink).

## Apply

The two npm packages are wired via `patchedDependencies` in package.json
(committed) — `bun install` applies them automatically.

**bun does NOT apply patchedDependencies to git-hosted dependencies** (verified
2026-07-24, bun 1.3.14: name, name@version, and name@git+...#ref keys all
silently ignored). The three git deps must be patched manually from a repo
checkout root:

    patch -p1 -d node_modules/tiny-hypergraph < perf-patches/bun-tiny-hypergraph.patch
    # then, in order: bun-tiny-hypergraph-hypot.patch, bun-tiny-hypergraph-r5.patch,
    # bun-tiny-hypergraph-r1-compact-hop.patch, bun-tiny-hypergraph-g3-hoist.patch,
    # bun-tiny-hypergraph-r2-neighbor-alloc.patch
    patch -p1 -d node_modules/@tscircuit/high-density-a01 < perf-patches/bun-high-density-a01@0.0.36.patch
    patch -p1 -d node_modules/high-density-repair03 < perf-patches/bun-high-density-repair03.patch

WARNING — bun HARDLINKS node_modules files into ~/.bun/install/cache and every
other checkout. Editing node_modules in place contaminates the global cache and
all worktrees. `patch` replaces the file (breaks the hardlink — safe);
rm+cp also works. Never edit in place.

## Pristine reference copies

- npm packages: /tmp/checks-r3/checks-orig.js, /tmp/checks-r3/connmap-orig.js
  (or re-extract from the npm tarball); /tmp is volatile — durable copy at
  ~/personal/tscircuit-autorouter/perf-artifacts/tmp-rescue-2026-07-26/
- git deps: ~/.bun/install/cache/@GH@tscircuit-*@@@1/ (verified clean 2026-07-24)
- math-utils dists (upstream + patched, byte-exact):
  ~/personal/awt-r3/perf-artifacts/math-utils-fix/

## Contents (all verified result-identical unless noted)

- bun-tscircuit-checks@0.0.145.patch — checkViaTraceClearance spatial index
  (copied sibling pattern, ~8-9x micro), net-id lookup hoisting in
  checkEachPcbTraceNonOverlapping + via spacing checks, duplicate closest-point
  removal in getTraceObstacleClearance. Verified: 300 random seeds byte-identical
  error JSON.
- bun-circuit-json-to-connectivity-map@0.0.19.patch — areIdsConnected direct
  field access (no behavior change).
- bun-tiny-hypergraph.patch — computeG load hoisting (bit-identical),
  indexed-candidate-heap hole-sifting (bit-identical, 20k-op differential).
  NOTE: Math.hypot→sqrt swaps were REVERTED (2026-07-24) — ulp differences flip
  A* tie-breaks on real boards and broke 3 SVG snapshot tests.
- bun-tiny-hypergraph-hypot.patch — **QUALITY-GATED tier, apply AFTER
  bun-tiny-hypergraph.patch.** The round-4 Math.hypot→sqrt swap (13 sites,
  __h2 helper), re-activated 2026-07-26 after being lost from the live tree.
  NOT result-identical: sample-5 identity anchor moves 1048233 → 1053687
  iterations, and 3 SVG snapshots churn (bugreport51/58/60 — updated in the
  same commit). Justification: round-4 corpus gate measured 1.054x srj18
  aggregate with DRC 581→575 (net better), all dataset01 boards identical.
  One Math.hypot deliberately remains (selective-rerip :455, outside the
  measured swap; future R5 work).
- bun-tiny-hypergraph-r5.patch — **identity-safe, apply AFTER the hypot
  patch** (2026-07-26, round-5 small wins from the recovered portPointPathing
  analysis): R2a expansion-loop reorder (dominance check before computeH and
  the candidate object literal — dominated hops no longer allocate; dead
  post-allocation goal branch removed, goal returns at loop top), R4
  countNewIntersectionsPackedWithValues (packed int replaces the per-call
  tuple at both core.ts call sites; tuple API kept for compat), R6 shared
  getPortOwners() between the direct and alternate blocker searches (state
  provably unchanged between them; consumed as ReadonlyMap). Verified:
  sample-5 iterations exactly 1053687 (unchanged), DRC 0, repo tsc clean.
- bun-tiny-hypergraph-r1-compact-hop.patch — **identity-safe, apply AFTER the
  r5 patch** (2026-07-26, the round-5 headline structural win): every port has
  exactly 2 incident regions (loader guarantees it), so the A* hop space is
  2·portCount, not portCount·regionCount. getHopId becomes portId*2+side
  (throws on a non-incident region, per fail-loud policy); the sparse-mode
  Maps for best-cost/generation become Float64Array+Uint32Array; the heap's
  indexByHopId Map and closedHopIds Set become Int32Array positions +
  generation-stamped Uint32Arrays with O(1) clear; compact hopId is cached on
  each candidate at queue time so sift moves never recompute it (delivers R7).
  USE_SPARSE_CANDIDATE_STORAGE stays accepted but inert. Heap comparisons and
  move sequences verbatim. Verified: s5 iterations exactly 1053687 and s8
  exactly 1973601 (both unchanged), DRC 0/41, repo tsc clean;
  IndexedCandidateHeap constructor signature changed (portCount +
  incidentPortRegion) — no external constructions found in either repo.
- bun-tiny-hypergraph-g3-hoist.patch — **identity-safe, apply AFTER the r1
  patch** (2026-07-26, G3): computeG invariants hoisted per dequeued candidate
  via predeclared class fields populated before the neighbor loop (regionCache
  + its 5 fields, current-port angle incl. region-side ternary, currentPortZ,
  single-layer mask, congestion, candidate.g, portPenalty array ref, portX/Y
  for the DistanceAware subclass); regionArea precomputed at construction;
  viaSizeWithMarginSq lifted to module consts with an === guard routing
  non-default diameters through the original expression. Self-repopulating
  guard (expansionCandidate !== currentCandidate) keeps any unlisted call
  path identical. Verified: s5 1053687 / s8 1973601 iterations EXACT, DRC
  0/41, repo tsc clean.
- bun-tiny-hypergraph-r2-neighbor-alloc.patch — **identity-safe, apply AFTER the
  g3 patch** (2026-07-27, G2/R2 Step B; Step A's expansion-loop reorder
  already landed in the r5 patch as R2a): IndexedCandidateHeap goes fully
  struct-of-arrays — queued candidates are rows in a monotonic pool (Float64
  f/g/h, Int32 port/next/prevRegion/hopId, plain arrays for prevCandidate
  refs and lazily materialized objects, doubling growth, reset on clear),
  and the heap itself holds pool slot indices with f and hopId mirrored in
  parallel typed arrays (lockstep invariant), so sift loops compare the same
  doubles in the same order and never touch objects. Candidate objects are
  materialized only on dequeue/toArray — hops that are queued but never
  dequeued (dominated replacements, still-open at route end) no longer
  allocate. queue(candidate) keeps its exact old behavior (stores the
  object; dequeue returns it — reference identity preserved), _step branches
  once per dequeue via instanceof; the MinHeap fallback path
  (GreedyFinalRouteSolver) is byte-identical. f = g + h computed with the
  same operands inside queueFields. Verified: heap unit test fixed (was
  broken by the R1 constructor change) + extended for queueFields, package
  suite 68 pass / 9 pre-existing env fails, differential harness pre-vs-post
  800 random-grid cases (2 solver kinds) bit-identical digests (iterations,
  solved/failed, ripCount, portAssignment, regionSegments), anchors s5
  1053687 / s8 1973601 EXACT, DRC 0/41, repo tsc clean.
- bun-high-density-a01@0.0.36.patch — fillViaOccupants inlined + single-entry
  occupancy-version cache (A03 2.2x micro on dataset01 sample001), stepOnce /
  computeMoveCostAndRips invariant hoisting. Bit-identical outputs.
- bun-high-density-repair03.patch — sharesNet lookup reduction (5→2 per pair),
  createObstacleNetMatcher hoisted per obstacle in pushMovablesAwayFromObstacles.
  Equivalence verified by exhaustive small-case harness.
- bun-tscircuit-math-utils@0.0.36.patch (added 2026-07-26; npm-hosted →
  patchedDependencies applies it automatically) — the whole-dist diff of the
  two PR-ready branches in ~/personal/math-utils-fix: orientation() collinearity
  fix (exact-zero cross-product test → relative epsilon; kills false
  intersections from float dust), allocation removal (bit-identical, 1.94x on
  the function), clamped parametric closest-point solve (4.93x on the
  function, last-ulp only). Downstream measured: Tier-1 685.3s→620.9s (1.10x),
  sample 6 1.21x, with identical DRC/via/iteration counts on every board.
  Generated from perf-artifacts/math-utils-fix/{dist-upstream-v0.0.36 →
  dist-patched}; round-trip verified with git apply. NOTE the nested copy at
  circuit-json-to-connectivity-map/node_modules/@tscircuit/math-utils (v0.0.9)
  is a different code path and remains unpatched.
