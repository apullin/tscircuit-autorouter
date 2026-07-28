# Downstream visual-snapshot verification of the 3 upstream PRs (2026-07-28)

Context: on autorouter PR #1776 seveibar noted optimizers "don't necessarily see
the upstream visual snapshots." This is the receipt that we ran them.

## Method

- Cloned the downstream consumers fresh: `tscircuit/core` (@tscircuit/core,
  the repo with the big visual snapshot suite — 1063 test files, SVG schematic/
  PCB snapshots via bun-match-svg + 3D PNG snapshots) and
  `tscircuit/circuit-to-svg`. The meta repo `tscircuit/tscircuit` was already
  local. `bun install` from each repo's own lockfile (core resolves
  math-utils 0.0.36, capacity-autorouter 0.0.710, checks 0.0.146) — bun 1.3.14,
  same version as their CI (`bun-test.yml`).
- Reproducibility anchor: **math-utils v0.0.36 (tag cadf0e5) builds
  BYTE-IDENTICAL to the published npm dist** (all 37 dist .js files, tsup).
  So a dist built from a PR branch is exactly "published + the PR commits".
- Swap protocol: rm-then-cp the built `dist/` over
  `node_modules/@tscircuit/math-utils/dist` (never edit in place — bun
  hardlinks from its cache), run the full suite, restore, byte-verify restore.
- Legs: baseline (published), PR #43 (colinear fix, 77382b6),
  PR #43+#44 (fix + perf parametric solve, d3de325).

## Results

| Suite | baseline | #43 | #43+#44 |
|---|---|---|---|
| core: 1302 tests / 1063 files | **1271 pass / 0 fail / 31 skip** | identical (1271/0/31) | identical (1271/0/31) |
| core: snapshot diff artifacts (`*.diff.svg`/`*.diff.png`) | — | **0** | **0** |
| core: wall time (`--parallel=8`) | 143.3s | 143.6s | 141.8s |
| tscircuit meta repo: 3 smoke tests | 3/3 | 3/3 | 3/3 |

- **Zero visual snapshot changes in @tscircuit/core from either math-utils PR.**
  Expected: the colinear bug only fires on colinear-with-float-dust segment
  pairs (false intersection positives); core's test boards don't hit it.
- `circuit-to-svg`: **unaffected by construction** — no math-utils (or
  autorouter/checks) anywhere in its runtime dependency graph; its test
  fixtures are checked-in circuit JSON. Verified in its package.json + bun.lock.
- Autorouter PR #1776 (`maxInnerIterationsPerGrowthAttempt`): **inert
  downstream by construction** — grep across core, circuit-to-svg, and the
  meta repo finds no caller passing that parameter. (Upstream's own
  `/benchmark-all` CI on the PR independently showed identical quality
  metrics, P50 6.3→6.1s dataset01, P50 129.1→122.5s srj18.)
- Nested-copy caveat, stated for honesty: `circuit-json-to-connectivity-map`
  pins math-utils `^0.0.9` and keeps its own nested copy (2 instances in
  core's tree), so it would NOT receive the fix on upstream merge — behavior
  there is unchanged regardless. Its `doesLineIntersectLine` is a separate,
  older lineage.

## Artifacts

- Logs: session scratchpad `core-{baseline,mu43,mu4344}.log` (bun test full
  output). Built dists + pristine-base build in scratchpad `mu-{base,43,4344}/`.
- Clones: `~/personal/tscircuit-core`, `~/personal/circuit-to-svg`.
- All node_modules restored to published bytes after the runs (verified).
