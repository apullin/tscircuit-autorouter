# Upstream PR + issue staging (2026-07-26) — PRs FIRED 2026-07-28

- PR 1: https://github.com/tscircuit/math-utils/pull/43 (colinear fix)
- PR 2: https://github.com/tscircuit/math-utils/pull/44 (perf, stacked on #43)
- PR 3: https://github.com/tscircuit/tscircuit-autorouter/pull/1776 (growth cap)
- Issues below remain DRAFTED, not filed — still user-triggered.
- 2026-07-28: downstream visual-snapshot verification of all 3 PRs is DONE and
  clean — core suite identical-green (0 snapshot diffs), meta 3/3, c2s
  unaffected by construction, #1776 param unused downstream. Full method +
  numbers: `perf-artifacts/pr-staging/downstream-verification.md` (talking
  points for the PR threads).

Everything below is fully prepared (branches pushed to the apullin forks, bodies
written, tests green) but deliberately not opened: submitting publishes under
your GitHub identity, so that trigger stays with you. Fire each with the exact
command given, from this directory. Bodies live in `perf-artifacts/pr-staging/`.

## Order matters for the math-utils pair

PR 1 first; PR 2 is stacked on it (contains its commit).

### PR 1 — math-utils correctness (affects every consumer's DRC)

```bash
gh pr create -R tscircuit/math-utils \
  --head apullin:bugfix/orientation-collinear-robustness \
  --title "Fix colinear segments being reported as intersecting" \
  --body-file perf-artifacts/pr-staging/pr1-mathutils-fix.md
```

### PR 2 — math-utils perf (1.94x/4.93x on-function; 1.10x downstream Tier-1)

After PR 1 exists, edit the `#<PR1-number>` placeholder in the body file, then:

```bash
gh pr create -R tscircuit/math-utils \
  --head apullin:perf/parametric-segment-distance \
  --title "Remove per-call allocations and use a parametric solve for segment distance" \
  --body-file perf-artifacts/pr-staging/pr2-mathutils-perf.md
```

Do NOT submit from `perf/geometry-hot-path` — that branch lacks the correctness
commit (verified 2026-07-26; see math-utils-fix/PR-NOTES.md correction).

### PR 3 — autorouter: maxInnerIterationsPerGrowthAttempt silently ignored

```bash
gh pr create -R tscircuit/tscircuit-autorouter \
  --head apullin:bugfix/growth-attempt-iteration-cap \
  --title "fix: maxInnerIterationsPerGrowthAttempt was silently ignored" \
  --body-file perf-artifacts/pr-staging/pr3-autorouter-growth-cap.md
```

## Issues (autorouter repo) — drafted, fire at your discretion

```bash
gh issue create -R tscircuit/tscircuit-autorouter \
  --title "Is the CachedIntraNodeRouteSolver cache key complete? Cached failures can poison later solves" \
  --body-file perf-artifacts/pr-staging/issue-failure-cache.md

gh issue create -R tscircuit/tscircuit-autorouter \
  --title "Cross-node clearance: adjacent nodes can each be internally legal yet violate clearance at the shared boundary" \
  --body-file perf-artifacts/pr-staging/issue-cross-node-margin.md

gh issue create -R tscircuit/tscircuit-autorouter \
  --title "GrowShrink grown-node solves violate DRC by construction (scaleRoute scales coordinates but not thickness)" \
  --body-file perf-artifacts/pr-staging/issue-scale-route-thickness.md
```

Lower-priority observations, probably comments rather than issues:
- `TinyHypergraphPortPointPathingSolver._step` catch-and-continue fallback —
  already documented as the canonical anti-pattern example in this repo's own
  AGENTS.md; nothing new to report beyond "it is still there".
- `createInvalidDirectConnectionRoutes` fallback is dead code whenever
  GrowShrink is enabled (growth rescues every portfolio failure first) —
  worth a note if/when the scaleRoute issue is discussed.

## Also staged on the fork (no PR planned yet)

- `apullin/tscircuit-autorouter` branch `perf-ts-stack` — the full performance
  stack (~2.6-2.7x srj18 aggregate). Upstreaming this is a separate
  conversation: it should go as a curated series (drc-scoring, astar-hotloop,
  small result-identical batches), not one megabranch. See REVIEW-2026-07-26.md.
