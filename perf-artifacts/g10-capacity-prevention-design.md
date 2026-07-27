# G10 — Capacity-model prevention design (2026-07-27)

Status: DRAFT, pre-implementation. Evidence base: 20975dbc (4 bounds rejected;
"the planner over-commits nodes"), 270ca10e/16da17b0 (drop-one R1 gate),
G6 epilogue (g6-eviction-design.md: rescue economics lose to growth),
c92262a0 (98% of failures geometric).

## Problem

Per board, ~12 nodes (srj18) get more connections than they can route at
scale 1. They consume 68-88% of HD search discovering it, then get rescued by
growth (2x/4x/8x) whose compressed routes carry 48x-enriched DRC violations.
Every reactive fix is measured-closed: no local predictor (20975dbc), no
cheap rescue (G6: marginal feasibility costs doomed-class search), caps move
work instead of eliminating it (16da17b0). Prevention is the remaining lever.

## Mechanism map (verified 2026-07-27)

1. **Mesh granularity**: `calculateOptimalCapacityDepth(boardSpan, 0.5)`
   (getTunedTotalCapacity1.ts) sets MAX_DEPTH by halving width until the
   tuned capacity of a leaf ≤ 0.5. `getTunedTotalCapacity1` is GEOMETRY-ONLY
   (width/height/availableZ; single-layer clamp), docstring "tuned for two
   layers" — srj18 boards route 4. Subdivision itself is target/obstacle-
   driven up to MAX_DEPTH (CapacityMeshNodeSolver1.shouldNodeBeXYSubdivided),
   so dense regions are ALREADY at max depth and cannot split further.
2. **Pathing is capacity-blind**: tiny-hypergraph `regionCongestionCost`
   initializes to 0 for all regions (core.ts:479) and is populated only by
   selective-rerip after failures. The A* minimizes hops/port-penalties; a
   region can absorb arbitrarily many routes. Over-commitment is structural,
   not a tuning error — the capacity model never sees demand.
3. **The repo already has the demand/capacity estimator shape**:
   `calculateNodeProbabilityOfFailure` = estUsedCapacity/totalCapacity
   (via-weighted crossings over getTunedTotalCapacity1), computed per node
   AFTER pathing (nodePf stats). Prevention = consulting this ratio at
   assignment time instead of reporting it afterwards.

## Lever 1 — mesh granularity (cheap, first)

FINDINGS (2026-07-27, s8, serial sweep):
- `targetMinCapacity`/`capacityDepth` are DEAD OPTS in pipeline 7 (computed
  at :755-763, never consumed — pipeline 7's mesh comes from the topology
  planner + NodeDimensionSubdivisionSolver, not CapacityMeshNodeSolver).
  Sweep {0.4, 0.3, 0.25} byte-identical. Worth an upstream note.
- The REAL granularity knob is `maxNodeDimension` (NodeDimensionSubdivisionSolver
  grid cap, default 16mm). mnd=8: byte-identical (all s8 nodes already ≤8mm).
  mnd=4: 1267 nodes (+5%), resizes 12->14, iterations +23%, wall 75.8->63.3s,
  DRC 41->49. mnd=2: 1439 nodes (+19%), resizes 12->17, iterations +24%,
  wall 75.8->61.9s (-18%), hdStageWall 40.5->29.7 (-27%), DRC 41->28 (-13).
- Interpretation: granularity SUBDIVIDES over-commitment rather than curing
  it (grown-node count rises slightly), but smaller nodes make each HD
  candidate step cheaper (per-iteration cost falls ~33%) and the per-node
  search space shrinks superlinearly — net wall win despite +24% iterations.
  DRC is non-monotone (mnd=4 worse, mnd=2 much better) — quality landscape
  must be corpus-gated before any default talk; the mechanism is presumably
  grown-node-violation size vs cross-node violation count trading off.
Open: s6 sweep {4, 2} running; then corpus gates (srj18 x16, dataset01 x85)
at mnd=2 vs 16, and the mnd=1 point to find the ceiling.

S6 FINDINGS (2026-07-27): the granularity cost lands in PATHING —
SelectiveRerip exhausts its 2M*effort budget on finer meshes. mnd=8 AND
mnd=4 fail pathing at effort 1 (2.03M iters); mnd=2 fails at effort 2
(4.03M). mnd=4 + effort 2 COMPLETES: nodes 1741, resizes 36, iterations
4.85M (+63%), wall 217s (vs 225.5 base, -3.8%), hdStageWall 97.2s,
**DRC 34 vs 100 baseline (-66)**. Effort-2 control (mnd=16) running to
separate the mesh effect from the effort/schedule effect (effort changes
the supervisor fitness schedule, so the control is load-bearing).
Granularity is a QUALITY lever of the first rank if the control confirms
the mesh is causal — and it needs pathing budgets that scale with region
count (currently fixed 2M*effort) to productize.

## ATTRIBUTION (2026-07-27, controls complete) — TWO distinct levers

| config | s6 wall | s6 DRC | s6 iters |
|---|---|---|---|
| mnd=16 eff=1 (baseline) | 225.5 | 100 | 2.98M |
| mnd=16 eff=2 (control) | 251.1 (+11%) | 40 (-60) | 4.83M |
| mnd=4 eff=2 | 217.0 (-3.8%) | 34 (-66) | 4.85M |
| mnd=2 eff=3 | pathing FAIL (6M budget) | — | — |

- **EFFORT is the dominant s6 DRC lever** (100->40 at +11% wall): 2x
  budgets let borderline-feasible nodes solve without growth (or grow
  better) — s6's failures are partly budget-flavored, unlike s8's (98%
  geometric exhaustion per c92262a0).
- **Mesh adds marginal DRC on top of effort on s6** (40->34) but buys
  back the wall (+11% -> -4%): mnd=4/eff2 is PARETO-DOMINANT on s6.
- **On s8 the mesh works at FIXED effort 1**: mnd=2/eff1 = DRC 41->28,
  wall -18% (effort-2 controls queued to check interaction).
- mnd=2 needs >6M pathing iterations on s6 — dead on that board at any
  practical budget. s6 sweet spot is mnd=4; s8's is mnd=2.

## CORPUS GATE + VERDICT (2026-07-27, srj18 x16 @ mnd=4/eff2 vs default)

15/16 boards (s15 TIMED OUT at 900s — pathology even at 2x budget):
**wall +80% (1168.7s > 2099.1s), DRC -35% (468 > 306)**. Wins concentrate
on the DRC-heavy boards (s6 100->34 at -5% wall, s8 41->18, s13 108->81,
s14 124->86); easy boards pay +150-270% wall for nothing. VERDICT: strong
OPT-IN quality mode, not a default.

Attribution closure:
- Effort's mechanism: doubling budgets doubles EVERY candidate's schedule
  slice (fitness g = iterations/MAX; control iterations 1.97M -> 4.59M on
  s8). The DRC win is the global "more search = better winners" trade, NOT
  doomed-node rescue — doomed exhaustion is geometric (c92262a0); re-proving
  it at 2x budget just costs 2x.
- Targeted budgets DEAD: nodePf does not separate doomed nodes (cmn_166
  doomed at pf=0.000; cmn_434 healthy at pf=0.625) — third confirmation
  that doom has no local signature.
- Mesh granularity is load-bearing in the quality config (buys back
  ~15-25% of the effort wall at fixed budget) and works ALONE at eff1 on
  s8-class boards (mnd=2/eff1: -18% wall, -32% DRC) — but kills s6-class
  pathing at eff1. A global mnd reduction requires pathing budgets scaled
  by region count (they are fixed 2M*effort today).
- Product shape: pipeline opt-in `qualityMode` = {maxNodeDimension: 4,
  effort: 2} documented with this corpus table; plus an upstream note that
  targetMinCapacity/capacityDepth are silently dead in pipeline 7.

## Lever 2 — occupancy-charged congestion pricing (the real fix)

Negotiated congestion inside the existing A* (PathFinder-lite, NOT the
rejected wavefront rewrite): after each route commit (onPathFound),
increment `regionCongestionCost[region]` for traversed regions by
Δ ∝ 1/estimatedCapacity(region) (getTunedTotalCapacity1 shape, layer-aware).
The field already flows into g (core.ts:1553-1558) and survives rerip resets
(:950-971). Effect: routes prefer less-filled regions → the pathing solver
performs the "eviction" G6 did post-hoc, up front and for free.
Form: perf-patches/ tiny-hypergraph patch (F6 discipline). Risks: longer
paths/more vias; anchors change → full corpus gate. Tunable charge scale
(env for the sweep; a constant for the default).

## Lever 3 (only if 1+2 show the shape works)

Layer-aware recalibration of getTunedTotalCapacity1 itself (the formula has
no layer-count input; srj18 is 4-layer, dataset01 2-layer — the two corpora
separate the calibration). Uses regenerated PERF_NODE_DUMP labelled data
(s8, ~1200 nodes with outcomes) as ground truth.

## Gates and kill criteria

- Any candidate: anchors gate is N/A by construction (assignment changes →
  everything downstream changes). Quality gates: DRC ≤ baseline on every
  completed board, vias within noise, full srj18 + dataset01 walls.
- Kill: if L1+L2 together cannot remove ≥50% of doomed nodes on s8 without
  >5% corpus wall regression, record and close — the capacity model then
  needs demand-aware mesh generation (a research project, not a patch).
