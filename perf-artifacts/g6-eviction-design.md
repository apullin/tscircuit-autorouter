# G6 — Eviction + Re-path design (evict-before-grow)

Status: DRAFT, pre-implementation. Evidence base: 270ca10e / 16da17b0 (drop-one
R1 gate), 20975dbc (four bounds rejected), c92262a0 (failure causes),
REVIEW-2026-07-26.md §3 (grown-node 48x violation enrichment, 69% cross-node),
WINS.md TS_PARALLEL_HD_NODES ceiling analysis (62.5s straggler on s6).

## Problem

A handful of capacity nodes per board are over-committed by the decomposition
(getTunedTotalCapacity1 is tuned for 2 layers; boards have 4). No local
predictor exists (four analytic bounds + learned rule all REJECTED on 1222
labelled nodes). Today they are rescued by GrowShrink: re-solve at 2x/4x/8x
scale, compress routes back. Costs:

1. **Speed**: the doomed scale-1 search is unavoidable (no predictor), but the
   GROWTH searches are pure overhead — "growing sooner MOVES the work to the 2x
   scale rather than eliminating it" (16da17b0). Doomed nodes carry 68-88% of
   HD candidate work (incl. growth); the 62.5s straggler bounds the
   TS_PARALLEL_HD_NODES ceiling on s6.
2. **Quality**: grown nodes are 1% of the mesh but carry 47% of intra-node
   violations (48x enrichment) — scaleRoute() scales coordinates, not
   traceThickness/viaDiameter.

## Proven fact the design stands on

Removing ONE connection's port points from a doomed node makes the remainder
routable: 40/40 captured instances, 77% of individual single removals
(cm_2 95%, cmn_19 68%). The geometry is fine; the assignment committed one net
too many.

## Design: evict-before-grow

Trigger: the scale-1 portfolio exhausts all candidates (the only proven doom
signal — 98% of failures are search-exhaustion, geometric not budgetary).

Instead of growing, the HD-stage driver:
1. Picks a victim connection (below).
2. RE-PATHS the victim around the node: local detour through adjacent nodes,
   splicing the port-point chain (prevPortPointId/nextPortPointId are the
   authoritative global path encoding — getConnectionPortPointPairs pairs
   fragments by these links FIRST, sequential fallback second).
3. Re-solves the trimmed node at scale 1 (fresh portfolio, same as drop-one).
   Success (77% per victim) → done: no growth, no violation enrichment.
   Failure → next victim (budget K≈2), then fall back to ordinary GrowShrink
   (today's exact behavior — rescue guarantee preserved).
4. Recipient nodes on the detour: unsolved → just carry the extra port points;
   solved/in-flight → dirtied, routes replaced, re-solved once (cascade cap).

### Detour mechanics (per victim fragment pair)

Victim chain through doomed node X: ...Pa→P1→P2→Pb..., where P1 sits on edge
X|W1, P2 on edge X|W2 (W1/W2 = the nodes the victim came from / goes to;
P1/P2 are ON X's boundary but belong to both adjacent node lists).

Detour: find path W1→…→W2 through nodes adjacent around X (BFS over node
adjacency, depth ≤ 2, cost = recipient port-point count as congestion proxy,
X banned). Materialize new port point(s) Q on the traversed shared edges:
- W1,W2 adjacent: single Q on edge W1|W2 → fragments (P1→Q) in W1, (Q→P2) in W2.
- One intermediate M: Q1 on W1|M, Q2 on M|W2 → fragments in W1, M, W2.

Chain splice: P1.next=Q; Q.prev=P1; Q.next=P2; P2.prev=Q (per fragment).
X's lists lose P1/P2 for the victim; recipients gain their fragment pairs.

Downstream needs NOTHING new: stitching merges fragments by
connectionName/rootConnectionName + endpoint proximity
(ENDPOINT_MATCH_TOLERANCE=0.1mm, EndpointClusterIndex) — paired Q entries in
both adjacent node lists are the same point, fragments land like any other.
Repair stage and cache keys consume prev/next (Pipeline4:261,
CachedIntraNodeRouteSolver:143) — the splice keeps them consistent; the
trimmed node is a different cache input anyway (miss = safe).

### Victim selection

Evictable = connection whose presence in X is entirely pass-through (no
terminal port point with pcb_port_id inside X — those fragments must still
reach their endpoint in X and cannot detour).
Preference order: (a) fewest X-fragment-pairs (single crossing first),
(b) shortest detour (W1,W2 adjacent beats 2-hop), (c) recipient congestion
lowest. 77% of arbitrary removals work; any ordering heuristic is
quality-insurance, not correctness.

### Interaction with TS_PARALLEL_HD_NODES

Eviction orchestration lives in the HD-stage driver, not the node solvers.
Parallel mode: workers run scale-1-only attempts when eviction is enabled
(growth disabled worker-side); a scale-1 failure returns control to the main
thread, which evicts/re-paths/re-dispatches. Dirty recipients complete their
in-flight solve, then get re-dispatched with the added connection (result
replaced). All bookkeeping single-threaded → race-free. v1 may ship
sequential-only if the parallel composition shows cracks; the flags compose
by construction, not by accident.

### Guards (all flag-tunable)

- TS_EVICT_REPATH=1 master flag (default OFF until gated).
- Eviction attempts per node K=2, then GrowShrink fallback.
- Recipient dirty/re-solve cap R=1 per node; global eviction budget E=64/board.
- Detour depth ≤ 2 intermediate nodes; recipients banned for further detours
  while dirty.

## Expected effect (from measured numbers)

s8: 12 doomed nodes, today ≈ doomed-1x + 2x-search each. Eviction:
doomed-1x + ~1.3 scale-1 re-solves + detour (~ms) + ~1.5 neighbor re-solves
(small nodes). HD-stage ~15-25% faster; DRC tail loses the grown-node share
(47% of intra-node violations) on rescued nodes.
s6: stragglers grow to 4x/8x (62.5s ceiling) — eviction caps them at ~2
scale-1 searches; parallel ceiling rises correspondingly. DRC 99 target: big
reduction if eviction rescues dominate.
RISK: detour recipients could push cross-node violations (69% of violations
are cross-node pairs; margin defect is upstream, not ours) — quality gate on
the full corpus decides.

## Gate plan

1. Unit: detour/splice on synthetic nodes (chain consistency, pairing,
   stitch-tolerance), victim selection rules, fallback path.
2. Anchors with flag OFF: s5 1053687 / s8 1973601 iterations unchanged
   (flag-off inertness).
3. Flag ON: Tier-1 (5,8,10,6,12) walls + DRC vs stack baseline; s8 DRC must
   not exceed 41, s6 walls should drop materially; full srj18+dataset01
   gauntlet if Tier-1 passes.

## EPILOGUE — measured verdict (2026-07-27): NEGATIVE for speed, machinery parked

Built and measured: local-detour eviction behind TS_EVICT_REPATH (default
OFF), trigger tunable TS_EVICT_AFTER_GROWTH_FAILURES (default 1 = only after
the 2x attempt fails), K=2 attempts, budget 64/board. 10 unit tests; driver
orchestration at the GrowShrink growthAttempts transition; dirty-recipient
re-solve with route replacement; pipeline clone re-sync via onSolved.

Flag-off anchors exact (s5 1053687, s8 1973601, DRC 0/41). Measured:

| board | config | applied/rescued/noPlan | iterations | DRC | verdict |
|---|---|---|---|---|---|
| s8 | g=0 (evict at scale-1 failure) | 7/6/9 | 2130771 (+8.0%) | 44 (+3) | REJECTED |
| s8 | g=1 (default) | 0/0/0 | 1973601 (exact) | 41 (=) | inert by construction |
| s6 | g=0-ish baseline | — | 2981732 | 100 | baseline |
| s6 | g=1 | 1/1/5 (withoutVictim 0, rejectedPlans 5) | 3456917 (+16.0%, replicated) | 96 (-4) | REJECTED for speed |

Root causes, evidence-backed:
1. **Rescues are near-exhaustion searches.** A trimmed node is MARGINALLY
   routable; its re-solve burns doomed-class iterations (the drop-one
   experiment's 20s/instance budget hinted this). Growth makes the node EASY
   (fast search). One s6 eviction added +475k pipeline iterations (+16%).
   Eviction buys marginal feasibility; growth buys easy feasibility.
2. **Placement, not victims, is the bottleneck on the straggler board.** s6:
   0 nodes lacked pass-through victims; all 5 noPlan nodes had every victim's
   detour rejected (corner-shared endpoints / full edges / z constraints —
   doomed nodes sit in congestion hotspots, so their neighbors are dense too).
3. **Detours create cross-node violations** that cancel the growth-violation
   savings where growth already works (s8 g=0: +3 net despite 6 rescues).

What this MEANS for the campaign: the over-commitment premise is confirmed
on both boards (victims exist everywhere; 6/6 planned evictions rescued),
but the local repair economics cannot beat growth. The remaining lever is
the one 20975dbc named: prevent over-commitment in the capacity model
(getTunedTotalCapacity1 is tuned for 2 layers on 4-layer boards). This work
quantifies the per-node cost structure for that calibration, and the parked
machinery (evict + re-path + downstream re-sync, all proven consistent) is
the natural repair valve for whatever the prevention path misses. NOT
deleted: flag-off inert, anchors exact, like the P1 prototype before it.

Follow-ups ranked by evidence:
- Capacity-model prevention (the real fix; uses PERF_NODE_DUMP labels +
  these eviction stats as calibration truth).
- If eviction is ever revived: cost-CAPPED rescues (externalMaxIterations on
  the trimmed re-solve — accept only easy rescues) + tiny-hypergraph global
  re-path for placement (scout's v2 seam: subset solve with regionCongestion
  ban), and the parallel ceiling is where its value would show up.
