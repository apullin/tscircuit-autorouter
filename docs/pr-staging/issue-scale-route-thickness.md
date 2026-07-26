**GrowShrink's grown-node solves are DRC-violating relaxations by
construction: `scaleRoute()` divides coordinates by the scale factor but
passes `traceThickness` and `viaDiameter` through unscaled.**

A solution that is exactly legal inside a 2x-grown node (0.15mm gap at scale)
maps back to a **0mm real gap** after `scaleRoute()`; at 4x it maps to
overlap. The legality condition `gap = 0.30/s − 0.15 ≥ 0.1mm` holds only for
`s ≤ 1.2`.

Evidence (srj18 sample 8, direct geometry attribution over the final output):
grown nodes are **1.0% of the mesh (12/1,222) yet carry 47% of intra-node
clearance violations (8 of 17)** — about 48x enrichment.

Why this is a design discussion rather than a trivial fix: the relaxation is
load-bearing. Growth is what rescues nodes whose 1x portfolio exhausts (the
alternative — keeping k−1 legal routes and marking one connection invalid —
measured strictly worse downstream: a complete-but-slightly-illegal routing
repairs better than an incomplete legal one, because a stranded connection
forces the repair stages into worse global choices). Options that keep the
rescue property:

1. Scale thickness/via diameter along with coordinates (solve the *real*
   problem at reduced feature size), possibly clamped to manufacturable
   minimums, so grown solutions map back legal or nearly so.
2. Insert a legal `1.2x` rung before `2/4/8` so the common case never enters
   the illegal regime (measured: leading with 1.2 while keeping the larger
   rungs as backstop shifts violations down on some boards; a 1.2-only
   schedule is catastrophic on hard boards — nodes needing more scale fall
   through).
3. Feed grown-node provenance to the repair stages so their violations are
   prioritized for exact-geometry repair.

Can share the attribution data and the growth-schedule sweep numbers.
