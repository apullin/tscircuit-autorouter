**Adjacent capacity nodes can each be internally DRC-legal while their union
violates trace clearance across the shared boundary — by construction.**

Each intra-node solve keeps traces `obstacleMargin / 2 = 0.075mm` away from
the node boundary. Two adjacent nodes can therefore both be internally legal
while placing traces `0.15mm` apart center-to-center across the boundary —
below the `0.2mm` that 0.1mm-wide traces at 0.1mm clearance require.

Evidence (srj18 sample 8, final shipped output, direct geometry attribution —
each same-layer clearance violation attributed to its owning node(s) via the
solver's node geometry): 2,853 segments over 1,222 nodes produce 55 real
clearance violations, 0 unattributed. **38 of 55 (69%) pair traces owned by
two different nodes** — the cross-node mechanism above, not any single
solver's error. (For calibration: only ~44% would be expected near boundaries
by area.)

Possible directions, in increasing order of invasiveness:
1. Reserve the full `obstacleMargin` per side at node boundaries (costs
   routable area; may hurt completion on dense boards).
2. Make the boundary margin direction-aware: full margin only on boundaries
   shared with another routed node.
3. A cross-node clearance repair pass that runs before the exact-geometry DRC
   stage, targeted specifically at boundary pairs.

Can share the attribution tooling and per-violation data.
