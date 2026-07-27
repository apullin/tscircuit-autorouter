# Incremental DRC re-evaluation — design (2026-07-27)

Target: `exactGeometryDrcForceImproveSolver`, 10.5% (sample 8) / 17.5% (sample 6) of total wall
(WINS.md "Round 4" per-stage table, ~line 483; "Still open" item 1, ~line 517).
All code read from the consolidated perf checkout `~/personal/awt-perf-stack` (read-only survey;
no code changed, no benchmarks run). Every claim cites file:line in that tree.

---

## 0. Premise check — what the folklore gets wrong (and right)

1. **"The solver hot code lives in @tscircuit/checks, dist-only, so the only seam is
   repo-side."** Half right. The *check functions* are dist-only
   (`node_modules/@tscircuit/checks/dist/index.js`, 3214 lines, v0.0.145) — but they are
   **already patched** via bun `patchedDependencies`
   (`awt-perf-stack/package.json:99-103` → `perf-patches/bun-tscircuit-checks@0.0.145.patch`),
   so dist-level patching is an established, working channel. More importantly, the solver
   itself (`GlobalDrcForceImproveSolver`, `getDrcSnapshot`, `isBetterDrcSnapshot`) does NOT
   live in checks — it lives in **`high-density-repair03`**, a git dependency that ships full
   TypeScript source in node_modules
   (`node_modules/high-density-repair03/lib/solvers/GlobalDrcForceImproveSolver/`, package.json
   `"module": "lib/index.ts"`), and it too is already manually patched
   (`perf-patches/bun-high-density-repair03.patch`; manual-apply procedure + hardlink warning in
   `perf-patches/README.md:15-30`). **We can modify the solver at TS-source level.** The
   dirty-route plumbing that incremental DRC needs is therefore feasible, not blocked.

2. **"getDrcSnapshot re-runs the FULL DRC suite over the whole board per candidate."** True
   for the exact-geometry stage, with two mitigations already in place: the *current-best*
   snapshot is cached across iterations (`GlobalDrcForceImproveSolver.ts:260-262, 754-755` —
   only candidates cost), and the scoring evaluator already caches route-invariant work
   (contiguity check deleted from scoring, connMap base partition cached, circuit-json
   scaffold memoized — `create-pipeline7-relaxed-drc-evaluator.ts:16-32`,
   `lib/testing/getDrcErrors.ts:49-105`, `lib/testing/utils/convertToCircuitJson.ts:629-691`).
   That was the round-3 "scoring fix" (WINS.md ~line 405: sample 12 ~13 s/iter → ~1.4 s/iter).
   What remains per candidate IS a full-board 5-check suite + conversions.

3. **The solver name in the prompt is slightly off.** The pipeline stage
   `exactGeometryDrcForceImproveSolver` is a `GlobalDrcBranchPortfolioSolver`
   (concretely `ParallelGlobalDrcBranchPortfolioSolver`,
   `AutoroutingPipelineSolver7_MultiGraph.ts:700-743`), which runs up to three
   `GlobalDrcForceImproveSolver` branches (baseline / broad / via-in-pad) plus its own
   boundary snapshots. There is ALSO a second, earlier DRC force-improve stage
   (`globalDrcForceImproveSolver`, pipeline line 677-699, maxIterations 16) that runs
   **without** a drcEvaluator → package-internal `getDrcErrors`
   (`high-density-repair03/lib/solvers/GlobalDrcForceImproveSolver/getDrcErrors.ts`, 3 checks
   only) against a **nested, UNPATCHED** `@tscircuit/checks@0.0.123`
   (`node_modules/high-density-repair03/node_modules/@tscircuit/checks`). Its wall share is
   not in the Round-4 table; probe it before assuming it's free (see §5 Q3).

4. **The scoring contract is richer than "global counts/scores."** `isBetterDrcSnapshot`
   (`solverHelpers.ts:3205-3216`) is lexicographic on (count, issueScore, viaIssueCount) —
   all three are **additive over the error multiset**, which is exactly what makes an exact
   delta-based accept/reject decision possible (§3, D1). But `issueScore` severity is parsed
   with a **regex over the error message string** (`gap: X.XXXmm` / `required: X.XXXmm`,
   `solverHelpers.ts:132-153`) — error message *strings* are load-bearing for scoring, so any
   incremental path must produce byte-identical messages (or reuse the same code that builds
   them).

5. **Error ORDER is behavior-bearing.** `snapshot.errors` order drives the error-targeting
   rotation (`errorCursor` / `padTopologyErrorCursor` / targeted-sweep `slice`,
   `GlobalDrcForceImproveSolver.ts:293-310, 626-630`; `solverHelpers.ts:2756-2767`). Full-eval
   order = concatenation order of the five checks (`lib/testing/getDrcErrors.ts:148-156`) with
   each check's internal spatial-index iteration order; trace-overlap dedup is
   **first-violating-pair-wins** per trace pair (dist `index.js:1334-1338`), so even the
   reported gap/center for a persisting error can depend on index iteration order. Any design
   that recomputes errors from a different index must either reproduce this order exactly or
   go through a one-time order-canonicalization anchor change (quality-gated).

---

## 1. Actual call graph (file:line) and DRC evaluations per board

### 1.1 Wiring

```
AutoroutingPipelineSolver7_MultiGraph.ts:700-743   stage "exactGeometryDrcForceImproveSolver"
  → ParallelGlobalDrcBranchPortfolioSolver         lib/solvers/HighDensityRepairSolver/ParallelGlobalDrcBranchPortfolioSolver.ts:21
    (A2 parallel path only outside benchmark/CI/test — lib/parallel/autoEnable.ts policy 2b;
     benchmark numbers are the SEQUENTIAL path below)
  → GlobalDrcBranchPortfolioSolver                 node_modules/high-density-repair03/.../GlobalDrcBranchPortfolioSolver.ts:14
    phases: start → baseline → broad → viaInPad    (_step, :197-277)
  → GlobalDrcForceImproveSolver (per branch)       node_modules/high-density-repair03/.../GlobalDrcForceImproveSolver.ts:56
  → getDrcSnapshot                                 node_modules/high-density-repair03/.../solverHelpers.ts:158-217
    → createSimplifiedTraces                       solverHelpers.ts:84-130  (O(connections × routes) filter :94-97)
    → drcEvaluator closure                         lib/autorouter-pipelines/.../create-pipeline7-relaxed-drc-evaluator.ts:34-60
      → convertPipeline7HdRoutesToSimplifiedPcbTraces   .../convertPipeline7HdRoutesToSimplifiedPcbTraces.ts:22-77 (O(C×R) filter :39-41)
      → evaluateRelaxedDrc                         lib/testing/evaluate-relaxed-drc.ts:38-60
        → convertToCircuitJson                     lib/testing/utils/convertToCircuitJson.ts:650-741 (scaffold cached :677-691)
        → getDrcErrors                             lib/testing/getDrcErrors.ts:107-253
          → createDrcConnectivityMap (netMap clone/candidate)  :84-105
          → checkEachPcbTraceNonOverlapping        checks/dist/index.js:1241 (per-call segment flatMap + SpatialObjectIndex :1251-1289)
          → checkViaTraceClearance                 dist:2653 (spatial-indexed by our patch)
          → checkPadTraceClearance                 dist:2593 (spatial over pads)
          → checkSameNetViaSpacing                 dist:1795 (O(V²) pair loop)
          → checkDifferentNetViaSpacing            dist:1849 (O(V²) pair loop)
          [checkTracesAreContiguous dist:2096 — SKIPPED in scoring mode, getDrcErrors.ts:150-152]
    → getDrcIssueScore (regex over messages)       solverHelpers.ts:132-156
```

The evaluator config is built once per stage with `scoring: true`
(`AutoroutingPipelineSolver7_MultiGraph.ts:708-720`); the SAME closure serves as both
`drcEvaluator` and `viaInPadDrcEvaluator` (:729-730). Stage parameters: solver
`maxIterations: 32` (:731), `broadMaxIterations: 8` (:737), `viaInPadMaxIterations: 32`
(:736), `enableTargetedErrorSweep: true` (:733), `enableViaInPadLayerMoves: true` (:735),
`enableLargeBoardBroadFallback: false` (:732), effort = pipeline effort (1 default,
2 in qualityMode — pipeline :756-761).

### 1.2 Every getDrcSnapshot call site

Portfolio boundaries (`GlobalDrcBranchPortfolioSolver.ts`):
- `:199` start/input snapshot
- `:173` broad-branch input snapshot (after `applyBroadRepulsionForces`)
- `:217` baseline final, `:239` broad final, `:265` via-in-pad final
- `:136` via-in-pad input gate snapshot
(Parallel A2 twin: `ParallelGlobalDrcBranchPortfolioSolver.ts:74,102,145`;
worker `lib/parallel/a2BranchWorker.ts:87,100,117`.)

Inner solver (`GlobalDrcForceImproveSolver.ts`):
- `:262` initial (once per branch — cached thereafter via `outputSnapshot`, :755)
- `:381` trace-pair detour candidates (up to 64 variants, cursor-rotated, :343-398)
- `:418` terminal-via relocation candidates (2 endpoint sides, :400-447)
- `:466` via-in-pad layer-move candidates (layerCount variants, :448-495)
- `:522` trace-pair layer-move candidates (2 sides × layers, :496-554)
- `:587` targeted clearance sweep (1 combined candidate, :568-617)
- `:649` per-error force candidates (≤3 force scales [1, 1.75, −1], solverConfig.ts:5-6, loop :619-682)
- `:713` broad-fallback candidates (2 pass multipliers [1, 2], :703-745)
- `:767` tryFinalAcceptance (only if never stepped to solved)
- `:184` post-solve relaxation re-eval — DISABLED in this stage (`enablePostSolveClearanceRelaxation: false`, pipeline :734)

`isBetterDrcSnapshot` call sites: `GlobalDrcForceImproveSolver.ts:433, 481, 538, 596, 658, 723`
(the detour loop at :390 compares raw counts only). All comparisons are against scalars
(`bestIssueCount/bestIssueScore/bestViaIssueCount`) — the contract consumes exactly three
additive aggregates plus the error list itself for targeting.

### 1.3 Evaluations per board (static loop structure + measured anchor)

Per iteration of one branch (effort 1): candidate cap = `3 × effort`
(`solverConfig.ts:3, 76-80`; shared across via-in-pad/targeted/error-force phases,
`candidateAttemptsThisStep` guard at :316, 359, 401, 449, 502, 633) **plus** up to 2
broad-fallback evals NOT counted against the cap (:703, fires whenever no candidate accepted
and routes ≤ `BROAD_FALLBACK_SMALL_ROUTE_LIMIT` = 120, solverConfig.ts:19, or effort ≥ 2 with
stall ≥ 2, :695-699). So **≤5 full evals/iteration at effort 1, ≤8 at effort 2**.

Iterations: baseline ≤32, broad ≤8, via-in-pad ≤32 (configured caps override DRC-scaled
growth, :154-158). Early exit via plateau logic (:198-256): 2 failed improvement checks
(`MAX_DRC_COUNT_PLATEAU_CHECKS=2`, solverConfig.ts:31) at interval 1/2/8 depending on initial
count (solverConfig.ts:64-71) — small-count boards exit in a handful of iterations; ≥20-error
boards run deep.

Bounds per stage run: **9 boundary snapshots** (of which 3 are exact duplicates — the branch
solver's `:262` initial snapshot recomputes what the portfolio just computed at `:199/:173`,
and branch finals `:217/:239/:265` recompute the branch's own cached `outputSnapshot`; free
win, §3 P0) **+ ≤72 iterations × ≤5 evals ≈ up to ~370 full-suite evals/board at effort 1**
(~590 at effort 2).

Measured anchor (WINS.md ~line 405, srj18 sample 12 post-scoring-fix): 41 iterations, 55.7 s
stage wall, ~1.4 s/iteration → **~3-4 evals/iteration at ~0.35-0.45 s per full-suite eval**
on a large board. Typical boards: tens to low-hundreds of full evals per stage run. No
per-run candidate counters exist in the artifacts (`globalDrcForceImproveCandidateAttempts`
is in `stats`, `GlobalDrcForceImproveSolver.ts:138`, but no benchmark log dumps it — probe Q1).

---

## 2. What one full snapshot costs, and which checks dominate

Per candidate eval, in call order (all O(board), none O(change)):

| step | cost shape | evidence |
|---|---|---|
| `cloneRoutes` + `materializeRoutes` of ALL routes per candidate | O(R × points) alloc | solverHelpers.ts:50-55, 2734-2738; called per candidate at e.g. GlobalDrcForceImproveSolver.ts:365/377, 402/414, 635/646 |
| `createSimplifiedTraces` (solver-side) + `convertPipeline7HdRoutesToSimplifiedPcbTraces` (evaluator-side) | O(C × R) filter + full route re-conversion | solverHelpers.ts:94-97; convertPipeline7HdRoutesToSimplifiedPcbTraces.ts:39-41 |
| `convertToCircuitJson` | scaffold cached; vias + traces rebuilt O(R) with global via location-dedup | convertToCircuitJson.ts:677-691 (cache), 694-701 + 560-622 (per-call; location dedup Set :600-614) |
| `createDrcConnectivityMap` | base netMap cached but **cloned wholesale per candidate** + per-via addConnections | lib/testing/getDrcErrors.ts:74-105 |
| `checkEachPcbTraceNonOverlapping` | per-call segment flatMap over all traces + fresh `SpatialObjectIndex` over segments+pads+holes+vias+keepouts, then per-segment neighborhood gap tests | dist:1251-1289; pair math = K1 family |
| `checkViaTraceClearance` | per-call SpatialObjectIndex over segments (our patch), per-via query | dist:2653+; patch lines 113-148 of bun-tscircuit-checks@0.0.145.patch |
| `checkPadTraceClearance` | per-call SpatialObjectIndex over pads, per-segment query | dist:2593-2646 |
| `checkSameNetViaSpacing` + `checkDifferentNetViaSpacing` | **O(V²) pair loops ×2** (net-ids precomputed by our patch) | dist:1795-1902; patch lines 71-108 |
| error-center decoration + severity regex per error | O(errors), string work | lib/testing/getDrcErrors.ts:171-242; solverHelpers.ts:132-156 |

Which checks dominate: the pre-scoring-fix profile
(`perf-artifacts/kernel-inventory.md`) had K1 segment-distance family at ~22% self /
`doesLineIntersectLine` 24.2% total, but that was driven by the contiguity check the scoring
fix deleted (kernel-inventory.md:16-19). The **post-fix residual inside this stage** is: K1
segment-segment gaps inside `checkEachPcbTraceNonOverlapping` over S ≈ 2,000-6,000 segments
(kernel-inventory.md:12-13), K2 via×segment 0.3-0.9M point-segment ops/call *before* the
spatial-index patch cut it (kernel-inventory.md:186-189), via-pair O(V²) ≈ 2 × 42k cheap
float ops at V≈290, plus the **per-call rebuild overhead** (segment extraction, three spatial
index builds, netMap clone, route conversion) which the checks patch did NOT touch and which
is pure O(board) tax per candidate. No fresh per-check profile exists post-Round-4
(kernel-inventory TODO ~line 46) — see probe Q2 before betting on arithmetic vs rebuild
split.

---

## 3. Candidate designs

### P0 (freebie, do first): eliminate duplicate boundary snapshots

The portfolio recomputes snapshots the branch already holds: branch-initial (:262) duplicates
portfolio :199/:173 (same routes, same evaluator closure), and branch finals :217/:239/:265
duplicate the branch's `outputSnapshot` (post-solve relaxation is off in this stage, so
`acceptSolvedRoutes` stores the exact snapshot, :181-192). Thread an optional
`initialSnapshot` param + read `outputSnapshot` (exposeable via a getter). Saves ~3-6 full
evals per stage run (~1-3 s on sample-12-class boards). **Result-identical trivially**
(same values, computed once). Effort: hours (patch to high-density-repair03 TS source +
regenerate `perf-patches/bun-high-density-repair03.patch`). Also P0-adjacent: kill the
O(C×R) filters with a route-by-connection map (solverHelpers.ts:94-97,
convertPipeline7HdRoutesToSimplifiedPcbTraces.ts:39-41).

### D1: Sound local screen + exact delta decision, full snapshot only on acceptance

**Idea.** Every candidate mutation except broad repulsion touches 1-2 routes with bounded
moves (`MAX_ERROR_MOVE=0.14`, `VIA_PAIR_REPAIR_MAX_MOVE=0.16`, `TRACE_PAD_REPAIR_MAX_MOVE=0.3`
— solverConfig.ts:15, 22, 23; the apply* helpers each mutate the nearest via/segment/route
pair — solverHelpers.ts:3218+, 2830, 2893, 3073, 3144). An error can appear or disappear
**only** if it involves geometry of a mutated route (pairwise checks are pure functions of
pair geometry + route-invariant net topology; per-candidate via→trace net merges only affect
the dirty trace's own net, getDrcErrors.ts:96-104). Therefore:

Δcount / ΔissueScore / ΔviaIssueCount = (errors touching dirty routes, after) − (before),

computable by running **the same five dist check functions** on a pruned circuitJson —
dirty traces' segments + vias, plus spatial neighbors within
(clearance + maxHalfWidth + move bound) as context — then keeping only errors whose ids
involve a dirty trace/via. Pair identity is recoverable from error ids
(`overlap_${idA}_${idB}` dist:1334, `pad_trace_clearance_${padId}_${traceId}` dist:2630-2632,
via-pair ids in `pcb_error_id`, solverHelpers.ts:2769-2773). Reusing the real check code gives
message-string parity (severity contract, §0.4) for free on the recomputed side. Because
`isBetterDrcSnapshot` compares only the three additive aggregates, the accept/reject decision
is **exact**. Rejected candidates never materialize a snapshot; accepted candidates (rare —
acceptance ends the phase/step: :564, :610, :672, :740) trigger ONE full eval to become the
new base — which also preserves error ordering exactly (§0.5), since every `bestSnapshot`
the targeting logic ever sees still comes from a full eval.

- **Correctness risk: MEDIUM.** The screen must be *complete* (enumerate every affected
  pair). Known traps: global via location-dedup across routes in conversion
  (convertToCircuitJson.ts:600-614 — a dirty route's via can be suppressed by a clean
  route's identical-location via; replicate with refcounted via keys); first-violating-pair
  dedup means a persisting trace-pair error's gap/message can differ if subset index
  iteration order differs from full (affects issueScore only on count ties — quantify in
  verify mode, escape hatch = min-gap canonicalization patch to the check, anchor-gated);
  layer/net semantics must use the patched `idsShareNet` logic (patch lines 25-39).
  Mitigation: `TS_INCREMENTAL_DRC_VERIFY=1` mode computes both paths and asserts
  (Δcount, Δscore, ΔviaCount) equality per candidate.
- **Expected win.** Candidate evals (the ~3-5×/iteration bulk) drop from O(board) to
  O(neighborhood); full evals remain only at acceptances + boundaries (≈ iterations, not
  attempts). Sample-12 arithmetic: ~1.4 s/iter → bounded by ~1 full eval per *accepting*
  iter + cheap screens ≈ 0.4-0.6 s/iter → stage ~2-3x faster. Against the 10.5-17.5%
  budget: **~5-11% total wall on eval-heavy boards**, less where the stage exits early.
- **Effort: MEDIUM (1-2 weeks).** Repo-side: pruned-input entry point in
  `lib/testing/getDrcErrors.ts` accepting a prebuilt connMap + explicit clearances; delta
  evaluator + spatial neighbor query (reuse flatbush or the package's grid,
  spatialIndex.ts:31-95). Package-side patch: apply* helpers report dirty route indexes
  (they already return changed booleans; extend to indexes), evaluator interface gains an
  optional `evaluateCandidateDelta(base, dirtyRouteIndexes)` — `DrcEvaluator` type is
  package-owned (types.ts:7-13) but patchable TS.
- **Classification: result-identical** (decision-identical by construction, ordering
  preserved via full-eval bases; verify-mode-backed). Broad-repulsion candidates (all routes
  dirty) simply fall back to full eval — they're ≤2/iteration and only on stall.

### D2: Persistent incremental error store + SoA geometry tables

**Idea.** The kernel-inventory §3 plan (SegmentTable/CircleTable Float32 SoA, interned ids,
threshold-join kernels — kernel-inventory.md:246-330): keep ONE stateful evaluator per stage
holding the geometry tables, a segment/via spatial index maintained incrementally, and the
error multiset keyed by canonical pair id with per-pair gap. Candidate eval = apply dirty
rows, delta pairs in/out, update aggregates; acceptance = commit; rejection = rollback
(shadow rows). No per-candidate conversion, no netMap clone, no index rebuild, no full eval
even at acceptance.

- **Correctness risk: HIGH.** Must reimplement the five checks' semantics (gap formulas,
  EPSILON conventions, dedup, message strings for severity, error ordering). Ordering forces
  a **canonical-order anchor change** applied to the full path too (sort errors by pair id in
  the evaluator; one-time behavior change, quality-gated like Round-4's 581→575 precedent),
  plus severity would be computed from stored gaps rather than regex — a second anchor
  change. fp32 is safe for thresholded distances (~1e-4 mm error vs 5e-3 mm epsilon,
  kernel-inventory.md:56-66) but exact-intersection predicates stay fp64.
- **Expected win.** Removes the O(board) floor entirely: per-candidate cost →
  O(dirty pairs). Ceiling ≈ making the stage disappear (~10-17% total wall), and the tables
  are the prerequisite for portfolio-wide parallel candidate scoring later
  (kernel-inventory.md:184, 240-243). Realistic capture over D1: an *additional* ~2-5% of
  total wall — only worth it if D1's residual (full evals at accepts + rebuild overhead)
  still measures ≥4-5%.
- **Effort: LARGE (3-5 weeks + parity harness).**
- **Classification: quality-gated** (two anchor changes), converging to decision-identical
  against the canonicalized baseline.

### D3: Per-pair memoization keyed by segment-pair versions (assessed to kill early)

Version each route (bump on mutation), key pair-gap results by
(routeVersion_A, routeVersion_B, pairId), keep the existing full-suite loop. Saves only the
gap arithmetic; the per-call O(board) rebuild (segment flatMap, 3 spatial index builds,
conversions, netMap clone, iteration itself) — which the round-3 patch data suggests is now
a comparable or larger share than the arithmetic — remains untouched. Needs the same
dirty-route plumbing as D1 to compute keys. **Expected win: ~1.2-2x per eval at best
(~2-5% total wall), strictly dominated by D1 at similar plumbing cost.** Result-identical if
keys are sound. Recommendation: do NOT build standalone; its useful content (route
versioning) is a D1 sub-component. Kill criterion built in: if the Q2 probe shows check
arithmetic <40% of per-eval time, D3 is dead on arrival.

---

## 4. Phased plan with kill criteria

Standing rules: benchmarks per WINS.md tiers (Tier 0 = sample 5 A/B + byte-identity; Tier 1 =
`--sample-numbers 5,8,10,6,12 --dataset 18`; Tier 2 = 5-way gauntlet + quiet run). A2 stays
off in benchmark mode (autoEnable.ts policy 2b) so all gates measure the sequential path.
This campaign kills anything that measures negative.

**Phase 0 — instrumentation + duplicate-snapshot elimination (P0). ~1 day.**
Env-gated counters (`TS_DRC_EVAL_STATS=1`) at the getDrcSnapshot call sites (tag: boundary /
targeted / via-in-pad / sweep / force / broad) + per-eval ms split
(convert / connMap / per-check) in `lib/testing/getDrcErrors.ts`. Then P0 snapshot-passing.
- Gate: Tier 0 byte-identity (routes + iteration counts) for P0 — it must be provably
  result-identical. Tier 1: stage wall strictly ≤ baseline on all 5 boards.
- Kill: any Tier-1 board slower by >1% → revert P0 (keep counters).

**Phase 1 — D1 behind `TS_INCREMENTAL_DRC=1`, with `TS_INCREMENTAL_DRC_VERIFY=1`. 1-2 weeks.**
Scope: targeted-candidate paths only (error-force, terminal-via, layer-move, detour, sweep);
broad-repulsion candidates keep full eval.
- Gate A (correctness): Tier 1 with VERIFY on — **zero decision mismatches** on samples
  5, 8, 10, 6, 12 (mismatch = differing (Δcount, Δscore, ΔviaCount) or differing
  accept/reject). Off-by-severity-on-count-tie mismatches are counted and reported
  separately; >0.5% of candidates → stop and canonicalize min-gap first.
- Gate B (perf): Tier 1, VERIFY off: `exactGeometryDrcForceImproveSolver` stage wall −25%
  or better on samples 6 and 12; srj18 Tier-1 aggregate wall −2% or better; DRC error counts
  and completion identical on all 5 boards.
- Kill: Gate A unfixable within 2 days of debugging, or Gate B <1% aggregate → record in
  WINS.md negative results, keep Phase 0, stop.

**Phase 2 — flip default on + full-corpus gate. ~2 days.**
- Gate: srj18 full (16 samples, quiet, CI conditions): total wall improves ≥3%, no board
  slower >5%, completions ≥ baseline, total strict DRC within ±1 (this phase is
  result-identical, so expect exactly 0 drift; any drift = bug, not a trade).
  dataset01: 85/85 identical outputs.
- Kill: any DRC drift (it's a correctness bug by definition here), or aggregate <2%.

**Phase 3 — D2 persistent store, ONLY IF the Phase-2 profile still shows the stage ≥5% of
total wall.** Split into 3a (canonical error ordering + gap-based severity as an anchor
change, full path only) and 3b (SoA store).
- Gate 3a (quality-gated): srj18 full — total DRC within ±1% (Round-4 precedent: 581→575
  accepted), completions not lower, no board slower >5%. Re-anchor snapshots after.
- Gate 3b: stage wall on samples 6/12 −50% vs post-Phase-2, decision-identical vs 3a
  baseline in verify mode; aggregate srj18 ≥2% over Phase 2.
- Kill 3 outright if Phase-2 residual stage share <4% (Amdahl: a 2x on <4% is <2% total —
  below this campaign's noise floor of ±1.5% on Tier 1) or if 3a's quality gate fails twice.

---

## 5. Open questions needing a measurement first

- **Q1 — How many candidate evals actually occur, split by call-site tag and branch?**
  Probe: Phase-0 counters, Tier-1 run, dump `stats` (the fields already exist:
  `globalDrcForceImproveCandidateAttempts`, `...ViaInPadCandidateAttempts`,
  `...StalledIterations` — GlobalDrcForceImproveSolver.ts:131-152) per stage per sample.
  Decides: how much D1 can win (attempts/acceptance ratio) and whether broad-fallback evals
  (excluded from D1 scope) matter.
- **Q2 — Per-eval time split: conversion vs connMap-clone vs each of the five checks.**
  Probe: timers in `lib/testing/getDrcErrors.ts:107-156` + `evaluate-relaxed-drc.ts:38-60`,
  one run of samples 6 and 12. Decides: D3's death certificate, and whether D1 should also
  prune the conversion path or only the checks.
- **Q3 — Wall share of the FIRST DRC stage** (`globalDrcForceImproveSolver`, pipeline
  :677-699, internal 3-check path against nested unpatched checks 0.0.123). Probe: the
  Round-4 per-stage table regeneration on the current tree (same method as WINS.md ~line
  478). If it's ≥3%, the cheapest fix is bumping/patching the nested dep, not incremental
  eval.
- **Q4 — Post-Round-4 in-stage profile** (kernel-inventory.md TODO ~line 46: the CPU profile
  predates merged work). Probe: `--cpu-prof` on sample 8, exact stage isolated via
  PipelineStageDebugRunner (lib/testing/PipelineStageDebugRunner.ts). Decides: D2's ceiling.
- **Q5 — Severity-tie sensitivity: how often do candidate decisions hinge on issueScore
  ties (count equal)?** Probe: counter in `isBetterDrcSnapshot` (patchable TS,
  solverHelpers.ts:3205-3216) logging which clause decided. Decides: how strict the
  first-pair-dedup parity work in D1 must be, and whether 3a's severity anchor change is
  low-risk.
- **Q6 — Dirty-route locality assert:** instrument apply* helpers to assert ≤2 routes
  mutated per targeted candidate across Tier 1 (statically evident, but the campaign's
  "computeG devirtualization" lesson — WINS.md Round-4 negative results — says verify scout
  claims before building on them).
