# perf-patches — round-3 dependency modifications (2026-07-24)

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
  (or re-extract from the npm tarball)
- git deps: ~/.bun/install/cache/@GH@tscircuit-*@@@1/ (verified clean 2026-07-24)

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
- bun-high-density-a01@0.0.36.patch — fillViaOccupants inlined + single-entry
  occupancy-version cache (A03 2.2x micro on dataset01 sample001), stepOnce /
  computeMoveCostAndRips invariant hoisting. Bit-identical outputs.
- bun-high-density-repair03.patch — sharesNet lookup reduction (5→2 per pair),
  createObstacleNetMatcher hoisted per obstacle in pushMovablesAwayFromObstacles.
  Equivalence verified by exhaustive small-case harness.
