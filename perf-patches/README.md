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
